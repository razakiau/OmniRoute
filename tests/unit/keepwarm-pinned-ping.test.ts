// ZAC-267 (homelab): keep-warm pings pinned to the account that served the chat.
// 1. Plugins learn which connection answered (onResponse / onStreamComplete).
// 2. A keep-warm ping that names its connection skips the model→combo mapping
//    (no combo quality check → no stray 502 row) and never revives an inactive
//    connection.
import { test, after } from "node:test";
import assert from "node:assert/strict";

const { registerHook, unregisterHook } = await import("../../src/lib/plugins/hooks.ts");
const { runPluginOnResponseHook, runPluginOnStreamCompleteHook } =
  await import("../../open-sse/handlers/chatCore/pluginOnResponse.ts");
const { pinnedKeepWarmConnection } = await import("../../src/sse/handlers/chat/keepWarmPin.ts");
const { strictForcedConnectionPool } = await import("../../src/sse/services/sessionAffinityPin.ts");

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !pred()) await new Promise((r) => setTimeout(r, 10));
}
after(() => {
  unregisterHook("onResponse", "kw-pin-resp");
  unregisterHook("onStreamComplete", "kw-pin-stream");
});

test("onResponse hands plugins the connection that answered", async () => {
  let seen: Record<string, unknown> | undefined;
  registerHook("onResponse", "kw-pin-resp", async (ctx: Record<string, unknown>) => {
    seen = ctx;
    return {};
  });
  await runPluginOnResponseHook({
    requestId: "r1",
    body: {},
    model: "claude-opus-5-5",
    provider: "claude",
    apiKeyInfo: null,
    connectionId: "conn-ultra",
    response: { status: 200, streamed: true },
  });
  await waitFor(() => seen !== undefined);
  assert.equal(seen!.connectionId, "conn-ultra");
});

test("onStreamComplete hands plugins the connection that answered", async () => {
  let seen: Record<string, unknown> | undefined;
  registerHook("onStreamComplete", "kw-pin-stream", async (p: Record<string, unknown>) => {
    seen = p;
    return {};
  });
  await runPluginOnStreamCompleteHook({
    status: 200,
    model: "claude-opus-5-5",
    provider: "claude",
    startTime: Date.now(),
    requestId: "r2",
    connectionId: "conn-ultra",
  });
  await waitFor(() => seen !== undefined);
  assert.equal(seen!.connectionId, "conn-ultra");
});

const h = (o: Record<string, string>) => new Headers(o);
test("a keep-warm ping naming its connection is pinned", () => {
  assert.equal(
    pinnedKeepWarmConnection(
      h({ "x-omniroute-keepwarm": "1", "x-omniroute-connection": " conn-ultra " })
    ),
    "conn-ultra"
  );
});
test("a connection header alone (no keep-warm marker) is not a keep-warm pin", () => {
  assert.equal(pinnedKeepWarmConnection(h({ "x-omniroute-connection": "conn-ultra" })), null);
});
test("a keep-warm ping without a connection is not pinned", () => {
  assert.equal(pinnedKeepWarmConnection(h({ "x-omniroute-keepwarm": "1" })), null);
  assert.equal(
    pinnedKeepWarmConnection(h({ "x-omniroute-keepwarm": "1", "x-omniroute-connection": "  " })),
    null
  );
});
test("no headers at all", () => {
  assert.equal(pinnedKeepWarmConnection(null), null);
});

// Strict pin: the pinned account or nothing. A sibling account would have no
// cache for this chat and the ping would write the whole prompt there.
const c = (id: string, rateLimitedUntil: string | null = null) => ({ id, rateLimitedUntil });
const base = {
  excludedConnectionIds: new Set<string>(),
  allowRateLimitedConnections: false,
  bypassQuotaPolicy: false,
  isQuotaExhausted: () => false,
  isQuotaPolicyBlocked: () => false,
};
test("strict pin keeps only the pinned account when it is usable", () => {
  const pool = strictForcedConnectionPool({
    ...base,
    forcedConnectionId: "ultra",
    connections: [c("ultra"), c("pro-1")],
  });
  assert.deepEqual(
    pool.map((x) => x.id),
    ["ultra"]
  );
});
test("strict pin on a cooling account gives no account, not a sibling", () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  assert.deepEqual(
    strictForcedConnectionPool({
      ...base,
      forcedConnectionId: "ultra",
      connections: [c("ultra", future), c("pro-1")],
    }),
    []
  );
});
test("strict pin on a quota-blocked or exhausted account gives no account", () => {
  assert.deepEqual(
    strictForcedConnectionPool({
      ...base,
      isQuotaExhausted: () => true,
      forcedConnectionId: "ultra",
      connections: [c("ultra"), c("pro-1")],
    }),
    []
  );
  assert.deepEqual(
    strictForcedConnectionPool({
      ...base,
      isQuotaPolicyBlocked: () => true,
      forcedConnectionId: "ultra",
      connections: [c("ultra"), c("pro-1")],
    }),
    []
  );
});
test("strict pin on an account not in the pool (inactive, or outside the key) gives no account", () => {
  assert.deepEqual(
    strictForcedConnectionPool({
      ...base,
      forcedConnectionId: "pro-off",
      connections: [c("ultra")],
    }),
    []
  );
});
test("strict pin with the forced id already dropped (after a failure) gives no account", () => {
  assert.deepEqual(
    strictForcedConnectionPool({
      ...base,
      forcedConnectionId: null,
      connections: [c("ultra"), c("pro-1")],
    }),
    []
  );
  const excluded = { ...base, excludedConnectionIds: new Set(["ultra"]) };
  assert.deepEqual(
    strictForcedConnectionPool({
      ...excluded,
      forcedConnectionId: "ultra",
      connections: [c("ultra"), c("pro-1")],
    }),
    []
  );
});
