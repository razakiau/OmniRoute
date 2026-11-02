// ZAC-283 (2026-11-02): the OmniRoute main process froze ~10 s; when it woke, the
// loader's hook timer SIGTERMed the healthy keep-warm child. Nothing respawned it and its
// hooks stayed registered, so every later request sent into a closed channel and waited
// out the 10 s timeout per hook (time to first token 0.8 s -> 11 s on every key).
//
// These tests pin the three fixes:
//  1. a call to a dead child rejects at once instead of waiting out the timeout;
//  2. the loader reports an unexpected exit (onExit) and the manager drops the dead
//     plugin's hooks and respawns it;
//  3. a main-process stall longer than the hook timeout does not kill a child whose
//     reply is already waiting in the IPC pipe.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadPlugin,
  type LoadedPlugin,
  type PluginExitInfo,
} from "../../src/lib/plugins/loader.ts";
import type { PluginManifestWithDefaults } from "../../src/lib/plugins/manifest.ts";
import type { PluginContext, PluginResult } from "../../src/lib/plugins/index.ts";

const HOOK_TIMEOUT_MS = 300;

function makeManifest(name: string): PluginManifestWithDefaults {
  return {
    name,
    version: "1.0.0",
    license: "MIT",
    main: "index.mjs",
    source: "local",
    tags: [],
    requires: { permissions: [] },
    hooks: { onRequest: true, onResponse: false, onError: false },
    skills: [],
    enabledByDefault: false,
    configSchema: {},
  } as PluginManifestWithDefaults;
}

const PLUGIN_SOURCE = `
export async function onRequest(ctx) {
  if (ctx.metadata && ctx.metadata.die) process.exit(7);
  if (ctx.metadata && ctx.metadata.sleepMs) await new Promise((r) => setTimeout(r, ctx.metadata.sleepMs));
  return { metadata: { pong: ctx.requestId, pid: process.pid } };
}
`;

async function setup(t: test.TestContext, name: string, onExit?: (i: PluginExitInfo) => void) {
  const dir = await mkdtemp(join(tmpdir(), `omniroute-${name}-`));
  const entry = join(dir, "index.mjs");
  await writeFile(entry, PLUGIN_SOURCE, "utf-8");
  const loaded = await loadPlugin(entry, makeManifest(name), {
    hookTimeoutMs: HOOK_TIMEOUT_MS,
    onExit,
  });
  t.after(async () => {
    loaded.cleanup();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return loaded;
}

const ctx = (requestId: string, metadata: Record<string, unknown> = {}) =>
  ({ requestId, body: {}, metadata }) as unknown as PluginContext;

async function waitFor(pred: () => boolean, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end && !pred()) await new Promise((r) => setTimeout(r, 20));
}

test(
  "a hook call to a dead plugin child fails at once, not after the timeout",
  { timeout: 20_000 },
  async (t) => {
    const exits: PluginExitInfo[] = [];
    const loaded = await setup(t, "dead-fast", (i) => exits.push(i));
    const first = (await loaded.plugin.onRequest?.(ctx("r1"))) as PluginResult;
    assert.equal(first?.metadata?.pong, "r1", "sanity: the plugin answers");

    await loaded.plugin.onRequest?.(ctx("die", { die: true }));
    await waitFor(() => exits.length > 0, 5_000);
    assert.equal(exits.length, 1, "onExit must fire when the child dies on its own");
    assert.equal(exits[0].code, 7);
    assert.equal(exits[0].expected, false, "an exit nobody asked for is unexpected");
    assert.equal(loaded.isAlive?.(), false);

    const started = Date.now();
    const after = await loaded.plugin.onRequest?.(ctx("r2"));
    const took = Date.now() - started;
    assert.equal(after, undefined, "fail-open: the dead plugin changes nothing");
    assert.ok(
      took < HOOK_TIMEOUT_MS / 2,
      `call to a dead child must reject at once; took ${took} ms`
    );
  }
);

test("cleanup() reports its exit as expected", { timeout: 10_000 }, async (t) => {
  const exits: PluginExitInfo[] = [];
  const loaded = await setup(t, "expected-exit", (i) => exits.push(i));
  await loaded.plugin.onRequest?.(ctx("r1"));
  loaded.cleanup();
  await waitFor(() => exits.length > 0, 5_000);
  assert.equal(exits[0]?.expected, true);
});

test(
  "a main-process stall past the hook timeout does not kill a child that already replied",
  { timeout: 20_000 },
  async (t) => {
    const exits: PluginExitInfo[] = [];
    const loaded = await setup(t, "stall", (i) => exits.push(i));
    await loaded.plugin.onRequest?.(ctx("warm"));

    const pending = loaded.plugin.onRequest?.(ctx("during-stall"));
    // Freeze this event loop well past the hook timeout, the way the 10 s GC/CPU stall
    // froze OmniRoute. The child answers within a few ms; the reply waits in the pipe.
    const until = Date.now() + HOOK_TIMEOUT_MS * 4;
    while (Date.now() < until) {
      /* busy */
    }
    const result = (await pending) as PluginResult;
    assert.equal(result?.metadata?.pong, "during-stall", "the waiting reply must be delivered");
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(exits.length, 0, "the healthy child must not be killed by a main-process stall");
    assert.equal(loaded.isAlive?.(), true);
  }
);

test(
  "a stall while the child is still working extends the deadline instead of killing it",
  { timeout: 20_000 },
  async (t) => {
    const exits: PluginExitInfo[] = [];
    const loaded = await setup(t, "stall-busy", (i) => exits.push(i));
    await loaded.plugin.onRequest?.(ctx("warm"));

    // The child needs 2/3 of the timeout; the main process stalls for 4x the timeout
    // right after sending. Only the child's own time should count.
    const pending = loaded.plugin.onRequest?.(
      ctx("slow-during-stall", { sleepMs: Math.round(HOOK_TIMEOUT_MS * 0.66) })
    );
    const until = Date.now() + HOOK_TIMEOUT_MS * 4;
    while (Date.now() < until) {
      /* busy */
    }
    const result = (await pending) as PluginResult;
    assert.equal(result?.metadata?.pong, "slow-during-stall");
    assert.equal(exits.length, 0);
  }
);

test(
  "a genuinely hung hook is still killed (isolation unchanged)",
  { timeout: 20_000 },
  async (t) => {
    const exits: PluginExitInfo[] = [];
    const loaded: LoadedPlugin = await setup(t, "hung", (i) => exits.push(i));
    await loaded.plugin.onRequest?.(ctx("r1", { sleepMs: 60_000 }));
    await waitFor(() => exits.length > 0, 5_000);
    assert.equal(exits.length, 1);
    assert.equal(exits[0].expected, false);
  }
);

// ── Manager: drop hooks and respawn ──

test(
  "pluginManager drops a dead plugin's hooks and respawns it",
  { timeout: 30_000 },
  async (t) => {
    const mgr = await import("../../src/lib/plugins/manager.ts");
    const db = await import("../../src/lib/db/plugins.ts");
    const hooks = await import("../../src/lib/plugins/hooks.ts");
    const { getDbInstance } = await import("../../src/lib/db/core.ts");
    getDbInstance();

    const name = "zac283-respawn-test";
    try {
      db.deletePlugin(name);
    } catch {}
    const root = await mkdtemp(join(tmpdir(), "zac283-mgr-"));
    const src = join(root, name);
    await mkdir(src, { recursive: true });
    await writeFile(
      join(src, "plugin.json"),
      JSON.stringify({ name, version: "1.0.0", main: "index.mjs", hooks: { onRequest: true } })
    );
    await writeFile(join(src, "index.mjs"), PLUGIN_SOURCE);

    const pm = mgr.pluginManager as unknown as {
      respawnDelaysMs: number[];
      loadedPlugins: Map<string, LoadedPlugin>;
    };
    pm.respawnDelaysMs = [50];
    t.after(async () => {
      try {
        await mgr.pluginManager.uninstall(name);
      } catch {}
      await rm(root, { recursive: true, force: true });
    });

    await mgr.pluginManager.install(src);
    await mgr.pluginManager.activate(name);
    const pidOf = async (id: string) => {
      const r = await hooks.emitHookBlocking("onRequest", ctx(id));
      return (r as { metadata?: { pid?: number } })?.metadata?.pid;
    };
    const pid1 = await pidOf("before");
    assert.ok(pid1, "sanity: the plugin answers through the hook registry");

    const first = pm.loadedPlugins.get(name);
    await hooks.emitHookBlocking("onRequest", ctx("die", { die: true }));
    await waitFor(() => first?.isAlive?.() === false, 5_000);
    await waitFor(() => pm.loadedPlugins.has(name) && pm.loadedPlugins.get(name) !== first, 10_000);
    const pid2 = await pidOf("after");
    assert.ok(pid2, "the plugin must be serving again after its child died");
    assert.notEqual(pid2, pid1, "a new child must have been spawned");
    assert.equal(db.getPluginByName(name)?.status, "active");

    assert.equal(
      hooks.getHooks("onRequest").filter((h) => h.pluginName === name).length,
      1,
      "the dead child's handler must be unregistered, leaving exactly one"
    );
  }
);
