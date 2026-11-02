/**
 * Plugin loader — loads plugins in isolated child processes.
 *
 * Uses a child Node.js process with IPC for process-level isolation. Each plugin
 * runs in a separate Node.js process with restricted environment.
 * Complies with Rule 3 (no eval/new Function/implied eval).
 *
 * @module plugins/loader
 */

import { spawn } from "child_process";
import type { ChildProcess } from "child_process";
import { writeFile, readFile } from "fs/promises";
import { rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID, createHash } from "crypto";
import { logger } from "../../../open-sse/utils/logger.ts";
import type { PluginManifestWithDefaults, Permission } from "./manifest";
import type { Plugin, PluginContext, PluginResult } from "./index";

const log = logger("PLUGIN_LOADER");

const DEFAULT_HOOK_TIMEOUT = 10_000;
const SIGKILL_GRACE_MS = 3_000;

// One-way notification hooks: no return value is consumed and they fire per-request
// (onStreamComplete fires once per completed stream). A timeout on one of these only
// DROPS the pending call — it must never kill the child process, because the
// kill-on-timeout path below has no respawn: one slow delivery (e.g. a plugin posting
// usage to a slow remote sink) would reject every in-flight hook call and leave the
// plugin dead-but-shown-active until a manual deactivate/activate. Blocking hooks
// (onRequest/onResponse/onError) and the rarely-fired lifecycle hooks keep the
// kill-on-timeout isolation semantics.
const NOTIFICATION_HOOKS: ReadonlySet<string> = new Set(["onStreamComplete"]);

// #8395: stdout/stderr forwarding hygiene — cap how much of a plugin's own console
// output we relay per stream, so a runaway/misbehaving plugin can't flood memory or
// the log sink. Mirrors the per-plugin rate-limit hygiene already used for hooks
// (hooks.ts::isRateLimited).
const MAX_FORWARDED_LINES_PER_STREAM = 500;
const MAX_FORWARDED_LINE_LENGTH = 4_000;

/**
 * Compute a `sha256-<base64>` integrity hash of the given source string.
 * Matches the SRI (Subresource Integrity) format: `sha256-<base64>`.
 */
export function computeIntegrity(source: string): string {
  const hash = createHash("sha256").update(source, "utf-8").digest("base64");
  return `sha256-${hash}`;
}

export interface LoadedPlugin {
  name: string;
  manifest: PluginManifestWithDefaults;
  plugin: Plugin;
  cleanup: () => void;
  /** false once the child process has exited. */
  isAlive?: () => boolean;
}

export interface PluginExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** true when cleanup() asked for the exit (deactivate/uninstall). */
  expected: boolean;
}

export interface LoadPluginOptions {
  /** Per-call IPC hook timeout in ms. Defaults to DEFAULT_HOOK_TIMEOUT (10s); injectable
   *  so tests can exercise the timeout paths without waiting out the production value. */
  hookTimeoutMs?: number;
  /** Called once when the child process exits, after pending calls were rejected.
   *  The manager uses it to unregister the dead plugin's hooks and respawn it (ZAC-283). */
  onExit?: (info: PluginExitInfo) => void;
}

// ── Main-process stall accounting (ZAC-283) ──
// On 2026-11-02 the OmniRoute main process froze ~10 s. While frozen it can neither
// flush a large child.send() (a multi-MB request body only partly fits the pipe) nor
// read the child's reply, yet the hook timer kept counting; when the loop woke, the
// timers phase fired before the poll phase and SIGTERMed a healthy child. A heartbeat
// measures how long the loop was stalled so the hook deadline is extended by that much:
// the timeout then only counts time the child actually had to answer.
const HEARTBEAT_MS = 200;
const STALL_THRESHOLD_MS = 1_000;
const MAX_STALL_EXTENSIONS = 3;
let lastBeat = Date.now();
let stalledMsTotal = 0;
let heartbeat: ReturnType<typeof setInterval> | null = null;

function beat(): void {
  const now = Date.now();
  const gap = now - lastBeat;
  if (gap > STALL_THRESHOLD_MS) stalledMsTotal += gap - HEARTBEAT_MS;
  lastBeat = now;
}

function ensureHeartbeat(): void {
  if (heartbeat) return;
  lastBeat = Date.now();
  heartbeat = setInterval(beat, HEARTBEAT_MS);
  heartbeat.unref?.();
}

/** Stalled ms so far, including a stall the heartbeat has not observed yet (it may run
 *  after the hook timer in the same timers phase). */
function stalledNow(): number {
  const pending = Date.now() - lastBeat;
  return stalledMsTotal + (pending > STALL_THRESHOLD_MS ? pending - HEARTBEAT_MS : 0);
}

/**
 * #8395: forward a plugin child process's stdout/stderr to the parent's structured
 * logger, line-buffered. Without this, plugin console.log/console.error output is
 * silently discarded at the OS level (the child is spawned with that stream set to
 * "ignore"), even though the plugin's hook handlers do run correctly over IPC.
 * Caps total forwarded lines per stream to avoid a runaway plugin flooding the log.
 */
function forwardChildOutput(
  stream: NodeJS.ReadableStream | null,
  pluginName: string,
  level: "info" | "error"
): void {
  if (!stream) return;

  let buffer = "";
  let forwardedLines = 0;

  stream.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf-8");
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (line.length > 0 && forwardedLines < MAX_FORWARDED_LINES_PER_STREAM) {
        forwardedLines++;
        const truncated =
          line.length > MAX_FORWARDED_LINE_LENGTH
            ? `${line.slice(0, MAX_FORWARDED_LINE_LENGTH)}…`
            : line;
        log[level]("plugin.output", { name: pluginName, line: truncated });
      }

      newlineIndex = buffer.indexOf("\n");
    }
  });
}

/**
 * Delete the generated host script synchronously. An async unlink loses the race
 * against process exit — under `node --test --test-force-exit` the runner exits
 * before the promise settles, leaking one temp .mjs per plugin load.
 */
/** Children already escalating to SIGKILL. Prevents re-arming a second timer + listener
 *  for a child that is already being killed. */
const escalating = new WeakSet<ChildProcess>();

/**
 * SIGTERM has already been sent; escalate to SIGKILL if the child ignores it.
 *
 * Must be idempotent per child. Every hook timeout hits this path, and a plugin that
 * traps SIGTERM keeps taking calls, so re-arming would add one exit listener plus one
 * killTimer closure per timeout — Node starts printing MaxListenersExceededWarning at 11.
 * One pending kill per child is also all that is useful: SIGKILL cannot be ignored, so a
 * second timer would only re-signal a corpse. (#12819)
 */
function escalateToSigkill(child: ChildProcess): void {
  if (escalating.has(child)) return;
  escalating.add(child);

  const onExit = () => {
    clearTimeout(killTimer);
    escalating.delete(child);
  };
  const killTimer = setTimeout(() => {
    child.removeListener("exit", onExit);
    escalating.delete(child);
    try {
      child.kill("SIGKILL");
    } catch {}
  }, SIGKILL_GRACE_MS);
  child.once("exit", onExit);
}

function removeHostScript(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Best-effort: a leftover temp script is harmless; a throw from an exit handler is not.
  }
}

// ── Plugin host script (runs in child process over IPC) ──
// Uses process.send()/process.on("message") — NOT worker_threads.
// Written as .mjs to force ESM execution regardless of package.json.

const PLUGIN_HOST_SCRIPT = `
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const require = createRequire(import.meta.url);

// pathToFileURL: on Windows a bare absolute path ("C:\\\\...") makes import()
// throw ERR_UNSUPPORTED_ESM_URL_SCHEME ("C:" is parsed as a URL scheme), so no
// plugin could ever load. file:// URLs work on every platform.
const pluginPath = process.argv[2];
const plugin = await import(pathToFileURL(pluginPath).href);
const exports = plugin.default || plugin;

// Send ready signal
process.send({ type: "ready", hooks: Object.keys(exports).filter(k => typeof exports[k] === "function") });

// Handle messages from parent
process.on("message", async (msg) => {
  if (msg.type === "call") {
    try {
      const handler = exports[msg.hook];
      if (typeof handler !== "function") {
        process.send({ type: "result", id: msg.id, error: "Hook not found" });
        return;
      }
      const result = await handler(msg.payload);
      process.send({ type: "result", id: msg.id, result });
    } catch (err) {
      process.send({ type: "result", id: msg.id, error: err.message });
    }
  }
});
`;

/**
 * Load a plugin in an isolated child process.
 * Returns the plugin interface with hooks that communicate via IPC.
 */
export async function loadPlugin(
  entryPoint: string,
  manifest: PluginManifestWithDefaults,
  options: LoadPluginOptions = {}
): Promise<LoadedPlugin> {
  const hookTimeoutMs = options.hookTimeoutMs ?? DEFAULT_HOOK_TIMEOUT;
  // Integrity check: if the manifest declares an integrity field, verify the entry point.
  // Missing integrity is OK for backward compatibility; mismatched integrity is a fatal error.
  const integrityField = (manifest as unknown as Record<string, unknown>).integrity;
  if (typeof integrityField === "string" && integrityField.length > 0) {
    let source: string;
    try {
      source = await readFile(entryPoint, "utf-8");
    } catch (err: unknown) {
      throw new Error(
        `Plugin '${manifest.name}' integrity check failed: cannot read entry point — ${err instanceof Error ? err.message : String(err)}`
      );
    }
    const actual = computeIntegrity(source);
    if (actual !== integrityField) {
      throw new Error(
        `Plugin '${manifest.name}' integrity mismatch: expected ${integrityField}, got ${actual}`
      );
    }
  }

  const permissions = manifest.requires.permissions;

  // IMPORTANT-6: Write the host script with O_EXCL (wx flag) so the open fails if
  // anything already exists at that path, defeating symlink/pre-create races (TOCTOU).
  // mode 0o600 ensures no other OS user can read or replace the script.
  // On EEXIST collision (astronomically unlikely with UUID but theoretically possible),
  // retry once with a fresh UUID.
  let hostScriptPath: string;
  {
    // .mjs extension forces ESM execution regardless of package.json type field
    const tryWrite = async (id: string): Promise<string> => {
      const p = join(tmpdir(), `omniroute-plugin-host-${id}.mjs`);
      await writeFile(p, PLUGIN_HOST_SCRIPT, { encoding: "utf-8", mode: 0o600, flag: "wx" });
      return p;
    };
    try {
      hostScriptPath = await tryWrite(randomUUID());
    } catch (err: unknown) {
      // EEXIST on a UUID path is a collision — retry once with a fresh UUID.
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === "EEXIST") {
        hostScriptPath = await tryWrite(randomUUID());
      } else {
        throw err;
      }
    }
  }

  const env: Record<string, string> = {
    ...getFilteredEnv(permissions),
    PLUGIN_ENTRY: entryPoint,
    PLUGIN_NAME: manifest.name,
  };

  const child = spawn(process.execPath, ["--no-warnings", hostScriptPath, entryPoint], {
    windowsHide: true,
    env,
    // #8395: stdout/stderr must be piped (not "ignore") so the plugin's own
    // console.log/console.error output — the SDK's documented logging pattern
    // (sdk.ts) — is observable on the parent side instead of discarded at the OS
    // level. See forwardChildOutput() below.
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });

  forwardChildOutput(child.stdout, manifest.name, "info");
  forwardChildOutput(child.stderr, manifest.name, "error");

  // Track pending calls with timeout support
  const pendingCalls: Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  > = new Map();
  let callCounter = 0;

  child.on(
    "message",
    (msg: { type: string; id?: string; hooks?: string[]; result?: unknown; error?: string }) => {
      if (msg.type === "ready") {
        log.info("loader.process_ready", { name: manifest.name, hooks: msg.hooks });
      } else if (msg.type === "result" && msg.id) {
        const pending = pendingCalls.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          pendingCalls.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(msg.error));
          } else {
            pending.resolve(msg.result);
          }
        }
      }
    }
  );

  child.on("error", (err) => {
    log.error("loader.process_error", { name: manifest.name, error: err.message });
  });

  let exited = false;
  let cleanupRequested = false;

  child.on("exit", (code, signal) => {
    exited = true;
    log.info("loader.process_exit", { name: manifest.name, code, signal });
    for (const [, pending] of pendingCalls) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Plugin process exited with code ${code}`));
    }
    pendingCalls.clear();
    removeHostScript(hostScriptPath);
    try {
      options.onExit?.({ code, signal, expected: cleanupRequested });
    } catch (err: unknown) {
      log.error("loader.on_exit_error", {
        name: manifest.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  ensureHeartbeat();

  // Call a hook in the child process with a timeout. Blocking/lifecycle hooks escalate
  // SIGTERM → SIGKILL on timeout; NOTIFICATION_HOOKS only drop the pending call.
  const callHook = (hook: string, payload: unknown, timeout = hookTimeoutMs): Promise<unknown> => {
    return new Promise((resolve, reject) => {
      // ZAC-283: a dead child used to make every call wait out the full timeout
      // ("Channel closed" on send, then 10 s per hook per request). Fail at once.
      if (exited || !child.connected) {
        reject(new Error(`Plugin '${manifest.name}' process is not running`));
        return;
      }
      const id = String(++callCounter);
      let stallBase = stalledNow();
      let extensions = 0;

      const onTimeout = () => {
        // Let the poll phase deliver a reply that is already sitting in the IPC pipe:
        // after a main-process freeze the timers phase runs before the socket is read.
        setImmediate(() => {
          const entry = pendingCalls.get(id);
          if (!entry) return; // the reply (or the exit) settled it first
          const stalled = stalledNow() - stallBase;
          if (stalled > STALL_THRESHOLD_MS && extensions < MAX_STALL_EXTENSIONS) {
            // The main process, not the plugin, used up this much of the deadline.
            extensions++;
            stallBase = stalledNow();
            log.warn("plugin.hook_timeout_extended_after_stall", {
              name: manifest.name,
              hook,
              stalledMs: stalled,
            });
            entry.timer = setTimeout(onTimeout, Math.min(stalled, timeout));
            return;
          }
          expire();
        });
      };

      const expire = () => {
        pendingCalls.delete(id);
        if (NOTIFICATION_HOOKS.has(hook)) {
          // Fire-and-forget notification: drop this delivery, keep the process. A late
          // "result" reply for this id is safely ignored by the message handler (the
          // pending entry is gone and ids are monotonic, never reused), so it cannot
          // reject unhandled or mis-match a later call.
          log.warn("plugin.notification_hook_timeout_dropped", {
            name: manifest.name,
            hook,
            timeout,
          });
          resolve(undefined);
          return;
        }
        child.kill("SIGTERM");
        // Escalate to SIGKILL if plugin ignores SIGTERM
        escalateToSigkill(child);
        reject(new Error(`Plugin hook '${hook}' timed out after ${timeout}ms`));
      };

      pendingCalls.set(id, { resolve, reject, timer: setTimeout(onTimeout, timeout) });
      child.send({ type: "call", id, hook, payload }, (err) => {
        if (!err) return;
        // "Channel closed" and friends: the call can never be answered, so settle it now.
        const entry = pendingCalls.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        pendingCalls.delete(id);
        entry.reject(new Error(`Plugin '${manifest.name}' IPC send failed: ${err.message}`));
      });
    });
  };

  // Build Plugin interface — only register hooks declared in the manifest.
  const plugin: Plugin = {
    name: manifest.name,
    priority: 100,
    enabled: true,
  };

  const registeredHooks: string[] = [];

  if (manifest.hooks.onRequest) {
    plugin.onRequest = async (ctx: PluginContext): Promise<PluginResult | void> => {
      try {
        const result = await callHook("onRequest", ctx);
        return result as PluginResult | void;
      } catch (err: unknown) {
        log.error("plugin.onRequest_error", {
          name: manifest.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };
    registeredHooks.push("onRequest");
  }

  if (manifest.hooks.onResponse) {
    plugin.onResponse = async (ctx: PluginContext, response: unknown): Promise<unknown | void> => {
      try {
        return await callHook("onResponse", { ctx, response });
      } catch (err: unknown) {
        log.error("plugin.onResponse_error", {
          name: manifest.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };
    registeredHooks.push("onResponse");
  }

  if (manifest.hooks.onError) {
    plugin.onError = async (ctx: PluginContext, error: Error): Promise<unknown | void> => {
      try {
        return await callHook("onError", { ctx, error: error.message });
      } catch (err: unknown) {
        log.error("plugin.onError_error", {
          name: manifest.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };
    registeredHooks.push("onError");
  }
  // ── Lifecycle + notification hooks (fire-and-forget, errors logged but don't block) ──
  // onStreamComplete is wired here too: like the lifecycle hooks it is a one-way
  // notification (no return value is consumed), so the same fire-and-forget IPC wrapper
  // applies. Without this branch the event fires into an empty registry and is dropped
  // for every disk-installed plugin (#11825).
  const lifecycleHooks: Array<{
    key: "onInstall" | "onActivate" | "onDeactivate" | "onUninstall" | "onStreamComplete";
    manifestFlag: boolean;
  }> = [
    { key: "onInstall", manifestFlag: manifest.hooks.onInstall },
    { key: "onActivate", manifestFlag: manifest.hooks.onActivate },
    { key: "onDeactivate", manifestFlag: manifest.hooks.onDeactivate },
    { key: "onUninstall", manifestFlag: manifest.hooks.onUninstall },
    { key: "onStreamComplete", manifestFlag: manifest.hooks.onStreamComplete },
  ];

  for (const { key, manifestFlag } of lifecycleHooks) {
    if (manifestFlag) {
      plugin[key] = async (payload: unknown): Promise<void> => {
        try {
          await callHook(key, payload);
        } catch (err: unknown) {
          log.error(`plugin.${key}_error`, {
            name: manifest.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      };
      registeredHooks.push(key);
    }
  }

  log.info("loader.loaded", {
    name: manifest.name,
    hooks: registeredHooks,
    pid: child.pid,
  });

  const cleanup = () => {
    cleanupRequested = true;
    child.kill("SIGTERM");
    // Escalate to SIGKILL after grace period
    escalateToSigkill(child);
    removeHostScript(hostScriptPath);
    log.info("loader.cleanup", { name: manifest.name });
  };

  return {
    name: manifest.name,
    manifest,
    plugin,
    cleanup,
    isAlive: () => !exited && child.connected,
  };
}

/**
 * Filter environment variables based on permissions.
 * Uses allowlist approach — only pass explicitly safe vars.
 */
function getFilteredEnv(permissions: Permission[]): Record<string, string> {
  // SystemRoot/windir are not optional on Windows: node aborts during
  // InitializeOncePerProcessInternal ("Assertion failed: ncrypto::CSPRNG") before
  // running any script, because its CSPRNG lives under %SystemRoot%. Without these
  // the child dies instantly, every hook times out, and — hooks being fail-open —
  // plugins silently stop applying. They carry no secrets.
  const platformKeys = process.platform === "win32" ? ["SystemRoot", "windir"] : [];
  const safeKeys = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "NODE_ENV", ...platformKeys];
  const extendedSafeKeys = [...safeKeys, "PORT", "HOSTNAME", "TZ", "TMPDIR"];
  const allowedKeys = permissions.includes("env") ? extendedSafeKeys : safeKeys;
  const env: Record<string, string> = {};

  for (const key of allowedKeys) {
    if (process.env[key] !== undefined) env[key] = process.env[key]!;
  }

  return env;
}
