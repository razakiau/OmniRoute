/**
 * keep-warm: OmniRoute plugin (ZAC-260).
 *
 * Why
 * ---
 * Anthropic's prompt cache lives 1 h after its last read. A Copilot chat that
 * waits longer than that for its owner (an ask_user question, lunch, a
 * meeting) pays its whole context again as a cache WRITE on the next call:
 * 268K tokens on Opus is ~$2.10. A request that reads the cache refreshes the
 * hour, and costs a tenth of a write. So while a big chat waits, replay its
 * last request with max_tokens 1 just before the hour runs out.
 *
 * Proven 2026-10-30: the client's EXACT body replayed through /v1 with
 * max_tokens 1 read the whole prefix (26,771 read, 0 stored); a stripped
 * body (messages trimmed) cached nothing. So the ping is the stored body,
 * byte for byte, with only max_tokens / stream_options overridden (and
 * stream forced on, as Copilot's calls are).
 *
 * What it does
 * ------------
 * onRequest   main-agent requests of the allowlisted keys (their tools carry
 *             ask_user / askUser; sub-agents and side calls do not) are
 *             stored, newest body per conversation. Conversation key: sha1 of
 *             key name + system message + first user message (stable across
 *             a chat's calls). Never changes the request; never logs bodies.
 * onResponse  non-stream usage, by requestId -> the conversation's size
 *             (OmniRoute passes {ctx: {...ctx, response}}: read under ctx).
 * onStreamComplete  the same for streams.
 * tick        every minute: for each conversation idle >= idleMin (and whose
 *             last ping is >= idleMin old), younger than the window, big
 *             enough (size x write price >= threshold), not disabled, not
 *             missed, with the daily fuse not hit: one ping, one at a time,
 *             a few seconds apart. A ping that reads nothing (cache_read 0)
 *             marks the conversation missed: no more pings until its next
 *             real call (a miss means every later ping would be a rewrite).
 *
 * State and settings live in the plugin's own OmniRoute config
 * (/api/plugins/keep-warm/config): `settings` is written by Ovis (switch,
 * window, fuse, per-chat opt-out), `state` by this plugin. Plugins cannot
 * register routes (loader.ts), and the config API is the one surface both
 * sides can reach: the plugin over loopback with the container's CLI token,
 * Ovis (CT 208, private LAN) with its access tokens.
 *
 * Files under the plugin dir (the dot names keep OmniRoute's plugin watcher
 * quiet; it ignores names starting with "."):
 *   config.json        defaults written by Ansible (allowlist, prices, ...)
 *   .key               the `keepwarm` API key the pings are sent with (0600)
 *   .store/            bodies, index.json, state.json, debug-token
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import * as nodeFs from "node:fs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const MARKER = "x-omniroute-keepwarm";
export const DEBUG_HEADER = "x-omniroute-keepwarm-debug";
const MIN = 60_000;
const HOUR = 60 * MIN;

/** Defaults; config.json (Ansible) overrides them, Ovis' settings override the switch/window/fuse. */
export const DEFAULTS = Object.freeze({
  enabled: true,
  allowKeys: ["mac-cli", "cde", "github-copilot"],
  mainTools: ["ask_user", "askUser"],
  idleMin: 55,
  windowHours: 8,
  fusePerDay: 200,
  thresholdUsd: 1,
  maxKeys: 200,
  maxBytes: 500 * 1024 * 1024,
  tickMs: MIN,
  gapMs: 3000,
  pingTimeoutMs: 60_000,
  flushAfterMs: 30_000,
  syncMs: MIN,
  baseUrl: "http://127.0.0.1:20128",
  // USD per million tokens, used when /api/pricing cannot be read. OmniRoute
  // 9e7fea28's own table (shared-tiers.ts). The write price is 2x input for
  // Claude: OmniRoute asks for the 1 h cache, billed at 2x input.
  prices: {
    "claude-opus-5-5": { input: 4, output: 20, cached: 0.2 },
    "claude-sonnet-5-5": { input: 2, output: 10, cached: 0.2 },
    "claude-haiku-5-5": { input: 1, output: 5, cached: 0.1 },
  },
});

const bare = (model) => String(model || "").split("/").pop();
export const writePrice = (model, input) => (/claude|anthropic/i.test(String(model)) ? input * 2 : input);
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function header(headers, name) {
  if (!headers || typeof headers !== "object") return "";
  const v = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(v) ? String(v[0] ?? "") : v == null ? "" : String(v);
}

function toolNames(body) {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  return tools.map((t) => t?.function?.name ?? t?.name).filter((n) => typeof n === "string");
}

/** The conversation key: stable across a chat's calls, different between chats. */
export function conversationKey(apiKeyName, body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const system = messages.filter((m) => m && (m.role === "system" || m.role === "developer"));
  const firstUser = messages.find((m) => m && m.role === "user") ?? null;
  return createHash("sha1")
    .update(`${apiKeyName}\n${JSON.stringify(body?.system ?? null)}\n${JSON.stringify(system)}\n${JSON.stringify(firstUser)}`)
    .digest("hex");
}

/**
 * The ping: the stored body with only what a ping must change: max_tokens
 * PING_TOKENS (and max_completion_tokens when the client sent it). Not 1:
 * with adaptive thinking (Opus/Sonnet 5.5) a 1-token answer is empty, and
 * OmniRoute's combo quality check turns an empty stream into a 502 and fails
 * over to the next target (live 2026-10-30: the subscription read 27,266,
 * then the paid connection wrote 27,247). 8 answered on Opus medium; 16 is
 * the margin, ~$0.0003 of output. Streamed like the
 * client's own calls: OmniRoute 9e7fea28 injects memory and skills tools only
 * when `stream !== true` (chatCore/memorySkillsInjection.ts:174, :221), and
 * tools come first in Anthropic's cache prefix, so a non-stream ping could get
 * a different prefix: a full write every hour instead of a read. Usage is
 * asked for (include_usage) so the last SSE chunk carries it. Thinking is
 * left as sent: Anthropic invalidates the messages' cache when thinking
 * settings change, so dropping it would turn the ping into a rewrite.
 */
export const PING_TOKENS = 16;
export function pingBody(body) {
  const out = { ...body, max_tokens: PING_TOKENS, stream: true, stream_options: { ...(body?.stream_options || {}), include_usage: true } };
  if ("max_completion_tokens" in out) out.max_completion_tokens = PING_TOKENS;
  return out;
}

/**
 * The usage of a streamed answer: the last `usage` any SSE `data:` chunk
 * carries (OpenAI's final chunk; Claude-shaped message_start/message_delta
 * usage merged). Null when none did.
 */
export function usageFromSse(text) {
  let found = null;
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    let json;
    try { json = JSON.parse(data); } catch { continue; }
    const u = json?.usage ?? json?.message?.usage;
    if (u && typeof u === "object") found = { ...(found || {}), ...u };
  }
  return found;
}

/** {prompt, read, write, output} from an OpenAI-shaped or Claude-shaped usage object. */
export function usageOf(usage) {
  if (!usage || typeof usage !== "object") return null;
  const details = usage.prompt_tokens_details || {};
  const read = num(usage.cache_read_input_tokens) || num(details.cached_tokens);
  const write = num(usage.cache_creation_input_tokens) || num(details.cache_creation_tokens);
  const prompt = num(usage.prompt_tokens) || num(usage.input_tokens) + read;
  return { prompt, read, write, output: num(usage.completion_tokens) || num(usage.output_tokens) };
}

/** A price table {model:{input, output, cached}} from /api/pricing's {provider:{model:{...}}}. */
export function pricesFrom(raw, provider) {
  const table = {};
  if (!raw || typeof raw !== "object") return table;
  const providers = Object.keys(raw).sort((a, b) => (a === provider ? -1 : b === provider ? 1 : 0));
  for (const p of providers) {
    const models = raw[p];
    if (!models || typeof models !== "object") continue;
    for (const [model, price] of Object.entries(models)) {
      const id = bare(model);
      if (table[id] || !price || typeof price.input !== "number") continue;
      table[id] = { input: price.input, output: num(price.output), cached: typeof price.cached === "number" ? price.cached : price.input / 10 };
    }
  }
  return table;
}

/** In-memory store, for tests. */
export function memoryStore() {
  const files = new Map();
  return {
    files,
    read: (name) => (files.has(name) ? files.get(name) : null),
    write: (name, text) => { files.set(name, text); },
    remove: (name) => { files.delete(name); },
  };
}

/** The plugin dir's `.store/`, written atomically (tmp + rename), 0600. */
export function dirStore(dir, fs = nodeFs) {
  return {
    read(name) {
      try { return fs.readFileSync(join(dir, name), "utf8"); } catch { return null; }
    },
    write(name, text) {
      const path = join(dir, name);
      fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const tmp = `${path}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, text, { mode: 0o600 });
      fs.renameSync(tmp, path);
    },
    remove(name) {
      try { fs.unlinkSync(join(dir, name)); } catch {}
    },
  };
}

/**
 * The plugin, with its clock, fetch, store and settings injected (tests drive
 * all four). `api(method, path, body)` talks to OmniRoute's management API;
 * `key()` returns the keepwarm API key or "".
 */
export function createKeepWarm({
  now = Date.now,
  fetch: fetcher = globalThis.fetch,
  store = memoryStore(),
  config = () => ({}),
  key = () => "",
  api = null,
  log = () => {},
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  let settings = {};
  let remotePrices = null;
  let pricesAt = 0;
  let problem = null;
  const index = new Map();
  const pending = new Map(); // key -> {body, at}: bodies not yet on disk
  const byRequest = new Map(); // requestId -> {key, real}
  let today = { day: dayOf(now()), pings: 0, usd: 0, avoided: 0, avoidedUsd: 0 };
  let pinging = false;
  let lastSyncedJson = "";
  const forcedAt = new Map();
  let debugToken = store.read("debug-token");
  if (!debugToken) {
    debugToken = randomBytes(24).toString("hex");
    store.write("debug-token", debugToken);
  }

  try {
    const saved = JSON.parse(store.read("index.json") || "null");
    if (saved && Array.isArray(saved.keys)) for (const e of saved.keys) if (e && e.key) index.set(e.key, e);
    if (saved && saved.today && saved.today.day === today.day) today = { ...today, ...saved.today };
  } catch {}

  const opts = () => {
    const c = { ...DEFAULTS, ...(config() || {}) };
    const s = settings || {};
    if (typeof s.enabled === "boolean") c.enabled = s.enabled;
    if (num(s.windowHours) > 0) c.windowHours = Math.min(24, s.windowHours);
    if (num(s.fusePerDay) > 0) c.fusePerDay = Math.min(1000, Math.floor(s.fusePerDay));
    c.disabled = new Set(Array.isArray(s.disabled) ? s.disabled.filter((k) => typeof k === "string") : []);
    return c;
  };

  const rollDay = () => {
    const d = dayOf(now());
    if (today.day !== d) today = { day: d, pings: 0, usd: 0, avoided: 0, avoidedUsd: 0 };
    for (const e of index.values()) if (e.day !== d) { e.day = d; e.pings = 0; e.usd = 0; }
  };

  const priceOf = (model) => {
    const id = bare(model);
    const c = opts();
    return (remotePrices && remotePrices[id]) || c.prices[id] || null;
  };
  const sizeOf = (e) => Math.max(num(e.prompt), num(e.read) + num(e.write));
  const restartUsd = (e) => {
    const p = priceOf(e.model);
    return p ? (sizeOf(e) * writePrice(e.model, p.input)) / 1e6 : 0;
  };

  function saveIndex() {
    store.write("index.json", JSON.stringify({ v: 1, today, keys: [...index.values()] }));
  }

  function evict() {
    const c = opts();
    const windowMs = c.windowHours * HOUR;
    for (const [k, e] of index) {
      if (now() - e.lastRealAt > windowMs + HOUR) drop(k);
    }
    let bytes = [...index.values()].reduce((s, e) => s + num(e.bytes), 0);
    const oldest = [...index.values()].sort((a, b) => a.lastRealAt - b.lastRealAt);
    while ((index.size > c.maxKeys || bytes > c.maxBytes) && oldest.length) {
      const e = oldest.shift();
      bytes -= num(e.bytes);
      drop(e.key);
    }
  }
  function drop(k) {
    index.delete(k);
    pending.delete(k);
    store.remove(`bodies/${k}.json`);
  }

  /** Bodies idle for flushAfterMs go to disk and leave memory; `all` on shutdown. */
  function flush(all = false) {
    const c = opts();
    for (const [k, p] of pending) {
      if (!all && now() - p.at < c.flushAfterMs) continue;
      if (index.has(k)) store.write(`bodies/${k}.json`, p.text);
      pending.delete(k);
    }
  }

  function onRequest(ctx) {
    try {
      const body = ctx && ctx.body;
      if (!body || typeof body !== "object" || !Array.isArray(body.messages)) return;
      if (header(ctx.headers, MARKER)) return;
      const c = opts();
      const name = ctx.apiKeyInfo && typeof ctx.apiKeyInfo.name === "string" ? ctx.apiKeyInfo.name : "";
      const debug = header(ctx.headers, DEBUG_HEADER);
      if (debug) {
        if (debug !== debugToken) return;
        const k = conversationKey(name, body);
        if (!index.has(k)) return { blocked: true, response: { keepWarm: { forced: null, reason: "unknown conversation" } } };
        // A combo runs onRequest once per target it tries: one forced ping per trigger.
        if (!forcedAt.has(k) || now() - forcedAt.get(k) > MIN) {
          forcedAt.set(k, now());
          setTimeout(() => { ping(k, true).catch(() => {}); }, 0);
        }
        return { blocked: true, response: { keepWarm: { forced: k.slice(0, 12) } } };
      }
      if (!c.allowKeys.includes(name)) return;
      const tools = toolNames(body);
      if (!tools.some((t) => c.mainTools.includes(t))) return;
      rollDay();
      const k = conversationKey(name, body);
      const t = now();
      const text = JSON.stringify(body);
      const e = index.get(k) || { key: k, apiKey: name, day: today.day, pings: 0, usd: 0, prompt: 0, read: 0, write: 0 };
      // A real call after a ping that kept the cache: the restart it would have cost was avoided.
      if (e.lastPingAt && e.lastPingAt > e.lastRealAt && !e.missed && t - e.lastRealAt >= HOUR && t - e.lastPingAt < HOUR) {
        today.avoided += 1;
        today.avoidedUsd += restartUsd(e);
      }
      e.model = typeof body.model === "string" ? body.model : String(ctx.model || "");
      e.provider = ctx.provider || e.provider || null;
      e.lastRealAt = t;
      e.missed = false;
      e.failures = 0;
      e.bytes = text.length;
      index.set(k, e);
      pending.set(k, { text, at: t });
      if (ctx.requestId) byRequest.set(ctx.requestId, { key: k, at: t });
      if (byRequest.size > 1000) byRequest.delete(byRequest.keys().next().value);
    } catch (err) {
      log(`onRequest: ${err && err.message}`);
    }
  }

  function record(requestId, usage) {
    const ref = requestId && byRequest.get(requestId);
    if (!ref) return;
    byRequest.delete(requestId);
    const e = index.get(ref.key);
    const u = usageOf(usage);
    if (!e || !u || u.prompt + u.read + u.write === 0) return;
    e.prompt = u.prompt; e.read = u.read; e.write = u.write;
    e.realAt = ref.at;
  }
  const onStreamComplete = (p) => { try { record(p && p.requestId, p && p.usage); } catch {} };
  // OmniRoute 9e7fea28 hands onResponse `{ctx: {...ctx, response}, response: undefined}`
  // (hooks.ts:348 calls handler({...ctx, response}); loader.ts wraps it as
  // callHook("onResponse", {ctx, response})): the request id and data are under `ctx`.
  const onResponse = (p) => {
    try {
      const c = (p && p.ctx) || p;
      const data = (c && c.response && c.response.data) ?? (p && p.response && p.response.data);
      if (data && typeof data === "object") record(c && c.requestId, data.usage);
    } catch {}
  };

  /** Whether `e` is kept warm now, and when its next ping is due. */
  function plan(e, c = opts()) {
    const t = now();
    const touch = Math.max(e.lastRealAt, e.lastPingAt || 0);
    const until = e.lastRealAt + c.windowHours * HOUR;
    const big = restartUsd(e) >= c.thresholdUsd;
    const kept = c.enabled && !c.disabled.has(e.key) && !e.missed && big && t < until && !!priceOf(e.model);
    const due = touch + c.idleMin * MIN;
    return { kept, big, until, due, ready: kept && t >= due && due < until && t - e.lastRealAt >= c.idleMin * MIN };
  }

  async function ping(k, forced = false) {
    const e = index.get(k);
    if (!e) return null;
    const apiKey = key();
    if (!apiKey) { problem = "no keepwarm key"; return null; }
    const text = pending.get(k)?.text ?? store.read(`bodies/${k}.json`);
    if (!text) { drop(k); return null; }
    rollDay();
    const c = opts();
    const t = now();
    let res, usage = null;
    try {
      res = await fetcher(`${c.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
          [MARKER]: "1",
          "x-omniroute-no-cache": "true",
        },
        body: JSON.stringify(pingBody(JSON.parse(text))),
        signal: AbortSignal.timeout(c.pingTimeoutMs),
      });
      // read to the end: the usage is in the last chunk
      const raw = await res.text().catch(() => "");
      usage = usageFromSse(raw);
      if (!usage) { try { usage = JSON.parse(raw)?.usage ?? null; } catch {} }
    } catch (err) {
      res = { status: 0 };
      log(`ping ${k.slice(0, 12)}: ${err && err.name}`);
    }
    const u = usageOf(usage) || { prompt: 0, read: 0, write: 0, output: 0 };
    const p = priceOf(e.model);
    const usd = p ? (u.read * p.cached + u.write * writePrice(e.model, p.input) + Math.max(0, u.prompt - u.read) * p.input + u.output * p.output) / 1e6 : 0;
    e.lastPingAt = t;
    e.lastPing = { at: t, status: res.status, read: u.read, write: u.write, forced };
    if (res.status === 200) {
      today.pings += 1; today.usd += usd;
      e.pings = (e.pings || 0) + 1; e.usd = (e.usd || 0) + usd;
      e.failures = 0;
      if (u.read === 0) e.missed = true;
    } else {
      e.failures = (e.failures || 0) + 1;
      // Two failures in a row (429 budget, 5xx, timeout): stop until the next real call.
      if (e.failures >= 2) e.missed = true;
    }
    log(`ping ${k.slice(0, 12)}: HTTP ${res.status} read=${u.read} write=${u.write}${e.missed ? " missed" : ""}`);
    saveIndex();
    await sync(true);
    return e.lastPing;
  }

  async function tick() {
    if (pinging) return 0;
    pinging = true;
    let sent = 0;
    try {
      rollDay();
      flush();
      evict();
      await refreshPrices();
      const c = opts();
      const due = [...index.values()].filter((e) => plan(e, c).ready).sort((a, b) => plan(a, c).due - plan(b, c).due);
      for (const e of due) {
        if (today.pings >= c.fusePerDay) break;
        if (sent > 0) await sleep(c.gapMs);
        if (!plan(e, opts()).ready) continue;
        await ping(e.key);
        sent++;
      }
      saveIndex();
    } finally {
      pinging = false;
    }
    return sent;
  }

  async function refreshPrices() {
    if (!api || now() - pricesAt < HOUR) return;
    pricesAt = now();
    try {
      const r = await api("GET", "/api/pricing");
      if (r && r.status === 200 && r.json) remotePrices = pricesFrom(r.json);
    } catch {}
  }

  function state() {
    rollDay();
    const c = opts();
    const keys = [...index.values()]
      .map((e) => {
        const pl = plan(e, c);
        return {
          key: e.key, model: e.model, apiKey: e.apiKey,
          tokens: sizeOf(e), prompt: e.prompt, lastRealAt: e.lastRealAt, realAt: e.realAt ?? null,
          lastPingAt: e.lastPingAt ?? null, nextPingAt: pl.kept && pl.due < pl.until ? pl.due : null,
          until: pl.until, pings: e.pings || 0, usd: e.usd || 0, restartUsd: restartUsd(e),
          missed: !!e.missed, disabled: c.disabled.has(e.key), kept: pl.kept,
          lastPing: e.lastPing ?? null,
        };
      })
      .filter((s) => s.tokens > 0 && restartUsd(index.get(s.key)) >= c.thresholdUsd)
      .sort((a, b) => b.lastRealAt - a.lastRealAt);
    return {
      v: 1, at: now(), enabled: c.enabled, windowHours: c.windowHours, fusePerDay: c.fusePerDay,
      idleMin: c.idleMin, thresholdUsd: c.thresholdUsd, available: !!key(), problem,
      today: { ...today, fuseHit: today.pings >= c.fusePerDay }, keys,
    };
  }

  /** Reads Ovis' settings; writes this plugin's state when it changed (and on `force`). */
  async function sync(force = false) {
    const s = state();
    store.write("state.json", JSON.stringify(s));
    if (!api) return;
    try {
      const r = await api("GET", "/api/plugins/keep-warm/config");
      const config = (r && r.status === 200 && r.json && r.json.config) || {};
      settings = config.settings && typeof config.settings === "object" ? config.settings : {};
      const fresh = state();
      const { at, ...stable } = fresh;
      const json = JSON.stringify(stable);
      if (!force && json === lastSyncedJson) return;
      // Re-read settings right before writing so an Ovis change is not overwritten.
      const again = await api("GET", "/api/plugins/keep-warm/config");
      const latest = (again && again.status === 200 && again.json && again.json.config) || config;
      const w = await api("PUT", "/api/plugins/keep-warm/config", { config: { settings: latest.settings ?? {}, state: fresh } });
      if (w && w.status === 200) lastSyncedJson = json;
    } catch (err) {
      log(`sync: ${err && err.message}`);
    }
  }

  return { onRequest, onResponse, onStreamComplete, tick, flush, sync, state, ping, plan: (k) => plan(index.get(k)), index, debugToken, setSettings: (s) => { settings = s || {}; }, save: saveIndex };
}

// ---------------------------------------------------------------------------
// Runtime wiring: only inside OmniRoute's plugin host (PLUGIN_NAME is set by
// loader.ts); importing this file from test.mjs starts nothing.

const here = dirname(fileURLToPath(import.meta.url));
let live = null;
const timers = [];

function readJson(path) {
  try { return JSON.parse(nodeFs.readFileSync(path, "utf8")); } catch { return {}; }
}

/** The container's loopback CLI token, derived the way the server checks it (plugin-converge.mjs). */
function cliToken() {
  try {
    const salt = JSON.parse(nodeFs.readFileSync(join(process.env.DATA_DIR || "/app/data", "cli-token-salt.json"), "utf8")).salt;
    if (!/^[0-9a-f]{64}$/.test(salt)) return null;
    const mid = createRequire("/app/package.json")("node-machine-id");
    const raw = (mid.machineIdSync || mid.default?.machineIdSync)(true);
    return raw ? { header: "x-omniroute-cli-token", value: createHmac("sha256", raw).update(salt).digest("hex") } : null;
  } catch {
    return null;
  }
}

function start() {
  if (live) return live;
  let cached = null, cachedAt = 0;
  const config = () => {
    if (!cached || Date.now() - cachedAt > 30_000) { cached = readJson(join(here, "config.json")); cachedAt = Date.now(); }
    return cached;
  };
  const base = () => ({ ...DEFAULTS, ...config() }).baseUrl;
  let token = null;
  const api = async (method, path, body) => {
    token ??= cliToken();
    if (!token) return { status: 0 };
    const res = await fetch(base() + path, {
      method,
      headers: { [token.header]: token.value, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    const json = await res.json().catch(() => null);
    if (res.status === 401) token = null;
    return { status: res.status, json };
  };
  const key = () => {
    try { return nodeFs.readFileSync(join(here, ".key"), "utf8").trim(); } catch { return ""; }
  };
  live = createKeepWarm({
    store: dirStore(join(here, ".store")),
    config, key, api,
    log: (line) => console.log(`[keep-warm] ${line}`),
  });
  const tickMs = () => ({ ...DEFAULTS, ...config() }).tickMs;
  const syncMs = () => ({ ...DEFAULTS, ...config() }).syncMs;
  timers.push(setInterval(() => { live.tick().catch(() => {}); }, tickMs()));
  timers.push(setInterval(() => { live.save(); live.sync().catch(() => {}); }, syncMs()));
  setTimeout(() => { live.sync().catch(() => {}); }, 2000);
  return live;
}

function stop() {
  while (timers.length) clearInterval(timers.pop());
  if (live) { live.flush(true); live.save(); }
}

if (process.env.PLUGIN_NAME === "keep-warm") start();

export function onRequest(ctx) { return live ? live.onRequest(ctx) : undefined; }
export function onResponse(ctx) { if (live) live.onResponse(ctx); }
export function onStreamComplete(payload) { if (live) live.onStreamComplete(payload); }
export function onActivate() { start(); }
export function onDeactivate() { stop(); }
