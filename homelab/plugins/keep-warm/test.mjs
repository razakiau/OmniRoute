// Tests for the keep-warm plugin (ZAC-260). No dependencies: `node test.mjs`.
// Runs on the controller and against the deployed copy inside the container
// (the role's test task), so the node that runs the plugin is the node that
// tested it. A fake clock, a fake fetch and an in-memory store: nothing here
// touches the network or the plugin dir.
import assert from "node:assert/strict";
import {
  createKeepWarm, memoryStore, conversationKey, pingBody, usageOf, usageFromSse, pricesFrom, writePrice, MARKER, DEBUG_HEADER,
} from "./index.mjs";

let n = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse("2026-10-30T09:00:00Z");
const SECRET = "BODY-SECRET-7f3a";

const tool = (name) => ({ type: "function", function: { name, description: "d", parameters: { type: "object", properties: {} } } });
const body = (opts = {}) => ({
  model: opts.model ?? "claude/claude-opus-5-5",
  stream: true,
  stream_options: { include_usage: true },
  max_tokens: 32000,
  tools: (opts.tools ?? ["ask_user", "view"]).map(tool),
  messages: [
    { role: "system", content: opts.system ?? "You are a coding agent." },
    { role: "user", content: opts.first ?? `First question ${SECRET}` },
    ...(opts.more ?? []),
  ],
});
const ctx = (b, extra = {}) => ({
  requestId: extra.requestId ?? `r-${Math.random()}`,
  body: b, model: b.model, provider: "claude",
  apiKeyInfo: { id: "k1", name: extra.key ?? "mac-cli" },
  headers: extra.headers ?? {},
});
// A 268K-token Opus chat: a restart costs 268K x $8/M = $2.14.
// An answer as OmniRoute streams it to an OpenAI client: content chunks, then a
// final chunk with an empty choices list and the usage, then [DONE].
const sse = (u) => [
  `data: ${JSON.stringify({ id: "c1", model: "claude-opus-5-5", choices: [{ index: 0, delta: { role: "assistant", content: "o" } }] })}`,
  `data: ${JSON.stringify({ id: "c1", model: "claude-opus-5-5", choices: [{ index: 0, delta: {}, finish_reason: "length" }] })}`,
  `data: ${JSON.stringify({ id: "c1", model: "claude-opus-5-5", choices: [], usage: u })}`,
  "data: [DONE]", "",
].join("\n\n");
// The payload OmniRoute 9e7fea28 hands onResponse: hooks.ts calls
// handler({...ctx, response}) and loader.ts wraps it as {ctx, response}.
const responsePayload = (c, data) => ({ ctx: { ...c, response: { status: 200, data } }, response: undefined });
const usage = (read = 260_000, write = 8_000, input = 0) => ({ prompt_tokens: input + read, completion_tokens: 50, cache_read_input_tokens: read, cache_creation_input_tokens: write });

function harness({ read = 260_000, status = 200, settings = null, config = {} } = {}) {
  let clock = T0;
  const sent = [];
  const logs = [];
  const fetch = async (url, init) => {
    sent.push({ url, init, body: JSON.parse(init.body), at: clock });
    const r = typeof read === "function" ? read(sent.length) : read;
    return { status, text: async () => sse({ prompt_tokens: r + 5, completion_tokens: 1, prompt_tokens_details: { cached_tokens: r, cache_creation_tokens: 0 } }) };
  };
  const kw = createKeepWarm({
    now: () => clock, fetch, store: memoryStore(), key: () => "sk-test-keepwarm",
    config: () => ({ gapMs: 0, ...config }), log: (l) => logs.push(l), sleep: async () => {},
  });
  if (settings) kw.setSettings(settings);
  const real = (b = body(), extra = {}) => {
    const c = ctx(b, extra);
    const r = kw.onRequest(c);
    kw.onStreamComplete({ status: 200, requestId: c.requestId, usage: usage() });
    return r;
  };
  return { kw, sent, logs, real, advance: (ms) => { clock += ms; }, at: () => clock };
}

// --- the request side --------------------------------------------------------
t("a main-agent request of an allowlisted key is stored, and left unchanged", () => {
  const h = harness();
  const b = body();
  const before = JSON.stringify(b);
  assert.equal(h.real(b), undefined);
  assert.equal(JSON.stringify(b), before);
  assert.equal(h.kw.index.size, 1);
});
t("a sub-agent body (no ask_user) is ignored", () => {
  const h = harness();
  h.real(body({ tools: ["view", "bash"] }));
  assert.equal(h.kw.index.size, 0);
});
t("askUser counts as the main agent too", () => {
  const h = harness();
  h.real(body({ tools: ["askUser"] }));
  assert.equal(h.kw.index.size, 1);
});
t("a key outside the allowlist is ignored", () => {
  const h = harness();
  h.real(body(), { key: "litellm" });
  assert.equal(h.kw.index.size, 0);
});
t("a request carrying the marker (our own ping) is ignored", () => {
  const h = harness();
  h.real(body(), { headers: { [MARKER]: "1" } });
  assert.equal(h.kw.index.size, 0);
});
t("the conversation key is stable across a chat's calls and differs between chats", () => {
  const a1 = conversationKey("mac-cli", body());
  const a2 = conversationKey("mac-cli", body({ more: [{ role: "assistant", content: "x" }, { role: "user", content: "y" }] }));
  assert.equal(a1, a2);
  assert.notEqual(a1, conversationKey("mac-cli", body({ first: "Another chat" })));
  assert.notEqual(a1, conversationKey("cde", body()));
});
t("the newest body per conversation is kept", async () => {
  const h = harness();
  h.real(body());
  h.advance(2 * MIN);
  h.real(body({ more: [{ role: "assistant", content: "newest" }] }));
  assert.equal(h.kw.index.size, 1);
  h.advance(56 * MIN);
  await h.kw.tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].body.messages.at(-1).content, "newest");
});

// --- the ping ----------------------------------------------------------------
t("the ping is the exact body with max_tokens 16, streamed like the client's calls, usage asked for", () => {
  const b = { ...body(), max_completion_tokens: 900, reasoning_effort: "high", thinking: { type: "adaptive" } };
  const p = pingBody(b);
  // 1 is an empty answer under adaptive thinking: OmniRoute's quality check fails it over to the paid target
  assert.equal(p.max_tokens, 16);
  assert.equal(p.max_completion_tokens, 16);
  // OmniRoute injects memory/skills tools only when stream !== true: a non-stream ping changes the cached prefix
  assert.equal(p.stream, true);
  assert.deepEqual(p.stream_options, { include_usage: true });
  assert.deepEqual(p.messages, b.messages);
  assert.deepEqual(p.tools, b.tools);
  assert.equal(p.reasoning_effort, "high");
  assert.deepEqual(p.thinking, b.thinking);
  assert.equal(b.stream, true, "the stored body is not mutated");
  // a client that streamed without usage: usage is asked for anyway; a non-stream client is streamed too
  assert.deepEqual(pingBody({ ...b, stream_options: undefined }).stream_options, { include_usage: true });
  assert.equal(pingBody({ ...b, stream: false }).stream, true);
});
t("the ping is sent streamed, and its usage is read from the last SSE chunk", async () => {
  const h = harness({ read: 250_000 });
  h.real();
  h.advance(56 * MIN);
  assert.equal(await h.kw.tick(), 1);
  assert.equal(h.sent[0].body.stream, true);
  const e = [...h.kw.index.values()][0];
  assert.equal(e.lastPing.read, 250_000);
  assert.equal(e.missed, false);
});
t("pings after 55 min idle, not before", async () => {
  const h = harness();
  h.real();
  h.advance(54 * MIN);
  assert.equal(await h.kw.tick(), 0);
  h.advance(1 * MIN);
  assert.equal(await h.kw.tick(), 1);
  const [s] = h.sent;
  assert.equal(s.url, "http://127.0.0.1:20128/v1/chat/completions");
  assert.equal(s.init.headers[MARKER], "1");
  assert.equal(s.init.headers["x-omniroute-no-cache"], "true");
  assert.equal(s.init.headers.authorization, "Bearer sk-test-keepwarm");
});
t("then again 55 min after the last ping, and stops after the 8 h window", async () => {
  const h = harness();
  h.real();
  for (let i = 0; i < 9 * 60; i++) { h.advance(MIN); await h.kw.tick(); }
  // 55, 110, ... 440 min: 8 pings inside 8 h (480 min); the 9th would be at 495.
  assert.equal(h.sent.length, 8);
  assert.ok(h.sent.every((s) => s.at - T0 < 8 * HOUR));
  assert.equal(h.kw.state().keys[0].kept, false);
});
t("a real call resets the clock: no ping until 55 min after it", async () => {
  const h = harness();
  h.real();
  h.advance(50 * MIN);
  h.real(body({ more: [{ role: "assistant", content: "a" }] }));
  h.advance(10 * MIN);
  assert.equal(await h.kw.tick(), 0);
  h.advance(45 * MIN);
  assert.equal(await h.kw.tick(), 1);
});
t("a small chat (restart under $1) is not pinged", async () => {
  const h = harness();
  const b = body({ model: "claude/claude-haiku-5-5" });
  const c = ctx(b);
  h.kw.onRequest(c);
  h.kw.onStreamComplete({ requestId: c.requestId, usage: usage(30_000, 1_000) }); // 31K x $2/M = $0.06
  h.advance(56 * MIN);
  assert.equal(await h.kw.tick(), 0);
});
t("non-stream usage (onResponse) sizes the chat too", async () => {
  const h = harness();
  const c = ctx(body());
  h.kw.onRequest(c);
  h.kw.onResponse(responsePayload(c, { usage: { prompt_tokens: 268_000, prompt_tokens_details: { cached_tokens: 260_000, cache_creation_tokens: 8_000 } } }));
  // sized from the payload's ctx: without it the chat has no size, is not big, and is never pinged
  assert.equal([...h.kw.index.values()][0].prompt, 268_000);
  h.advance(56 * MIN);
  assert.equal(await h.kw.tick(), 1);
});
t("the daily fuse stops every ping, across conversations", async () => {
  const h = harness({ config: { fusePerDay: 3 } });
  for (let i = 0; i < 5; i++) h.real(body({ first: `chat ${i}` }));
  h.advance(56 * MIN);
  assert.equal(await h.kw.tick(), 3);
  assert.equal(h.kw.state().today.fuseHit, true);
  h.advance(56 * MIN);
  assert.equal(await h.kw.tick(), 0);
});
t("the fuse resets at the next UTC day", async () => {
  const h = harness({ config: { fusePerDay: 1 } });
  h.real();
  h.advance(56 * MIN);
  assert.equal(await h.kw.tick(), 1);
  h.advance(15 * HOUR); // 2026-10-31
  h.real();
  h.advance(56 * MIN);
  assert.equal(await h.kw.tick(), 1);
});
t("a ping that reads nothing marks the chat missed and stops pinging it", async () => {
  const h = harness({ read: 0 });
  h.real();
  h.advance(56 * MIN);
  assert.equal(await h.kw.tick(), 1);
  const s = h.kw.state().keys[0];
  assert.equal(s.missed, true);
  assert.equal(s.kept, false);
  h.advance(56 * MIN);
  assert.equal(await h.kw.tick(), 0);
  // The next real call starts over.
  h.real();
  h.advance(56 * MIN);
  assert.equal(await h.kw.tick(), 1);
});
t("two failed pings in a row stop it too (a 429 budget, a 5xx)", async () => {
  const h = harness({ status: 429 });
  h.real();
  h.advance(56 * MIN); await h.kw.tick();
  h.advance(56 * MIN); await h.kw.tick();
  h.advance(56 * MIN);
  assert.equal(await h.kw.tick(), 0);
  assert.equal(h.sent.length, 2);
  assert.equal(h.kw.state().today.pings, 0, "a failed ping is not counted as one");
});
t("switched off globally, or per chat, from Ovis' settings", async () => {
  const off = harness({ settings: { enabled: false } });
  off.real();
  off.advance(56 * MIN);
  assert.equal(await off.kw.tick(), 0);

  const h = harness();
  h.real();
  h.real(body({ first: "other" }));
  const k = conversationKey("mac-cli", body());
  h.kw.setSettings({ disabled: [k] });
  h.advance(56 * MIN);
  assert.equal(await h.kw.tick(), 1);
  assert.notEqual(conversationKey("mac-cli", body({ first: "other" })), k);
  assert.equal(h.kw.state().keys.find((s) => s.key === k).disabled, true);
});
t("Ovis' window and fuse are honoured", async () => {
  const h = harness({ settings: { windowHours: 2, fusePerDay: 50 } });
  h.real();
  for (let i = 0; i < 4 * 60; i++) { h.advance(MIN); await h.kw.tick(); }
  assert.equal(h.sent.length, 2); // 55 and 110 min; 165 is past 2 h
  assert.equal(h.kw.state().fusePerDay, 50);
});
t("one ping at a time", async () => {
  const h = harness();
  h.real(); h.real(body({ first: "b" }));
  h.advance(56 * MIN);
  const [a, b] = await Promise.all([h.kw.tick(), h.kw.tick()]);
  assert.equal(a + b, 2);
  assert.equal(h.sent.length, 2);
});
t("state: next ping, today's tally, a restart avoided", async () => {
  const h = harness();
  h.real();
  let s = h.kw.state().keys[0];
  assert.equal(s.kept, true);
  assert.equal(s.nextPingAt, T0 + 55 * MIN);
  assert.equal(s.until, T0 + 8 * HOUR);
  assert.ok(Math.abs(s.restartUsd - 268_000 * 8 / 1e6) < 1e-9);
  h.advance(55 * MIN); await h.kw.tick();
  h.advance(20 * MIN); // 75 min after the last real call, 20 after the ping: still warm thanks to it
  h.real();
  s = h.kw.state();
  assert.equal(s.today.pings, 1);
  assert.equal(s.today.avoided, 1);
  assert.ok(s.today.avoidedUsd > 2 && s.today.usd > 0 && s.today.usd < 0.1);
});
t("the debug trigger forces a ping only with the right token, without storing the request", async () => {
  const h = harness();
  h.real();
  assert.equal(h.kw.onRequest(ctx(body(), { headers: { [DEBUG_HEADER]: "wrong" } })), undefined);
  const r = h.kw.onRequest(ctx(body(), { headers: { [DEBUG_HEADER]: h.kw.debugToken } }));
  assert.equal(r.blocked, true);
  assert.ok(r.response.keepWarm.forced);
  h.kw.onRequest(ctx(body(), { headers: { [DEBUG_HEADER]: h.kw.debugToken } })); // a combo's second target
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(h.sent.length, 1);
  assert.equal(h.kw.index.size, 1);
});
t("idle conversations are pruned, and the key cap evicts the oldest", async () => {
  const h = harness({ config: { maxKeys: 2 } });
  h.real(body({ first: "a" })); h.advance(MIN);
  h.real(body({ first: "b" })); h.advance(MIN);
  h.real(body({ first: "c" }));
  await h.kw.tick();
  assert.equal(h.kw.index.size, 2);
  assert.equal(h.kw.index.has(conversationKey("mac-cli", body({ first: "a" }))), false);
  h.advance(10 * HOUR);
  await h.kw.tick();
  assert.equal(h.kw.index.size, 0);
});
t("bodies survive a restart of the plugin (written to the store)", async () => {
  const store = memoryStore();
  let clock = T0;
  const sent = [];
  const mk = () => createKeepWarm({ now: () => clock, store, key: () => "k", config: () => ({ gapMs: 0 }), sleep: async () => {},
    fetch: async (u, i) => { sent.push(i); return { status: 200, text: async () => sse(usage()) }; } });
  const a = mk();
  const c = ctx(body());
  a.onRequest(c); a.onStreamComplete({ requestId: c.requestId, usage: usage() });
  clock += MIN; await a.tick(); // flushAfterMs 30 s: the body goes to disk
  a.flush(true); a.save();
  const b = mk();
  clock += 55 * MIN;
  assert.equal(await b.tick(), 1);
});
t("never logs a body", async () => {
  const seen = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const k of Object.keys(orig)) console[k] = (...a) => seen.push(a.join(" "));
  try {
    const h = harness({ read: 0 });
    h.real();
    h.advance(56 * MIN);
    await h.kw.tick();
    h.kw.onRequest({ body: { messages: "not-an-array" } });
    seen.push(...h.logs);
    seen.push(JSON.stringify(h.kw.state()));
  } finally {
    Object.assign(console, orig);
  }
  assert.ok(seen.length > 0);
  for (const line of seen) assert.equal(line.includes(SECRET), false, `leaked: ${line.slice(0, 80)}`);
});

// --- helpers -----------------------------------------------------------------
t("usage from an SSE stream: the last chunk's, Claude's message_start/delta merged, none without", () => {
  assert.deepEqual(usageOf(usageFromSse(sse({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 90, cache_creation_tokens: 0 }, completion_tokens: 1 }))), { prompt: 100, read: 90, write: 0, output: 1 });
  const claude = [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 0, output_tokens: 1 } } })}`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 1 } })}`,
  ].join("\n\n");
  assert.deepEqual(usageOf(usageFromSse(claude)), { prompt: 100, read: 90, write: 0, output: 1 });
  assert.equal(usageFromSse("data: {\"choices\":[]}\n\ndata: [DONE]\n\n"), null);
  assert.equal(usageFromSse("data: not json\n\n"), null);
});
t("onResponse in OmniRoute's real shape: the request is sized and its entry let go", async () => {
  const h = harness();
  const c = ctx(body(), { requestId: "req-1" });
  h.kw.onRequest(c);
  h.kw.onResponse(responsePayload(c, { usage: usage(200_000, 0) }));
  const e = [...h.kw.index.values()][0];
  assert.equal(e.prompt, 200_000);
  assert.ok(e.realAt);
  // the same response again: the request id was consumed, nothing changes
  h.kw.onResponse(responsePayload(c, { usage: usage(1, 0) }));
  assert.equal(e.prompt, 200_000);
});
t("usage from Claude, OpenAI non-stream, and stream shapes", () => {
  assert.deepEqual(usageOf({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 90, cache_creation_tokens: 5 }, completion_tokens: 1 }), { prompt: 100, read: 90, write: 5, output: 1 });
  assert.deepEqual(usageOf({ input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 0, output_tokens: 1 }), { prompt: 100, read: 90, write: 0, output: 1 });
  assert.equal(usageOf(null), null);
});
t("prices from /api/pricing, and the 2x write rule for Claude only", () => {
  const table = pricesFrom({ cc: { "claude-opus-5-5": { input: 4, output: 20, cached: 0.2 } }, deepseek: { "deepseek-v4": { input: 0.3, output: 1 } } });
  assert.equal(table["claude-opus-5-5"].input, 4);
  assert.equal(table["deepseek-v4"].cached, 0.03);
  assert.equal(writePrice("cc/claude-opus-5-5", 4), 8);
  assert.equal(writePrice("deepseek-v4", 0.3), 0.3);
});

for (const [name, fn] of tests) {
  try { await fn(); n++; } catch (e) { console.error(`FAIL ${name}\n${e.stack}`); process.exit(1); }
}
console.log(`keep-warm: ${n} tests passed`);
