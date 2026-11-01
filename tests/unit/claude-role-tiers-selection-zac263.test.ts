import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-role-tiers-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const auth = await import("../../src/sse/services/auth.ts");
const oauthOccupancy = await import("../../open-sse/services/oauthSessionOccupancy.ts");

async function resetStorage() {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  oauthOccupancy._clearOAuthSessionOccupancyForTest();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function seed(name: string, priority: number, overrides: Record<string, unknown> = {}) {
  return providersDb.createProviderConnection({
    provider: "claude",
    authType: "oauth",
    name,
    accessToken: `sk-ant-oat-${name}`,
    refreshToken: `rt-${name}`,
    isActive: true,
    testStatus: "active",
    priority,
    providerSpecificData: {},
    ...overrides,
  });
}

async function setup() {
  await settingsDb.updateSettings({ fallbackStrategy: "fill-first" });
  const max = await seed("max", 1);
  const team = await seed("team", 2);
  const pro = await seed("pro", 3);
  const tiers = { main: [[max.id], [team.id, pro.id]], subagent: [[team.id, pro.id], [max.id]] };
  return { max, team, pro, tiers };
}

type Options = NonNullable<Parameters<typeof auth.getProviderCredentials>[4]>;
const pick = (tiers: string[][], extra: Partial<Options> = {}) =>
  auth.getProviderCredentials("claude", null, null, "claude-opus-5-5", {
    connectionTiers: tiers,
    reserveOAuthSession: true,
    ...extra,
  });

test.beforeEach(resetStorage);
test.after(() => fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }));

test("tiers: a main chat goes to the main account", async () => {
  const { max, tiers } = await setup();
  const c = await pick(tiers.main, { sessionKey: "main-1" });
  assert.equal(c.connectionId, max.id);
});

test("tiers: a sub-agent goes to the pool, not to the higher-priority main account", async () => {
  const { team, tiers } = await setup();
  const c = await pick(tiers.subagent, { sessionKey: "sub-1" });
  assert.equal(c.connectionId, team.id);
});

test("tiers: main rate-limited sends a main chat to the pool", async () => {
  const { max, team, tiers } = await setup();
  await providersDb.updateProviderConnection(max.id, {
    rateLimitedUntil: new Date(Date.now() + 60_000).toISOString(),
  });
  const c = await pick(tiers.main, { sessionKey: "main-2" });
  assert.equal(c.connectionId, team.id);
});

test("tiers: one pool account out moves a sub-agent to the other pool account before main", async () => {
  const { team, pro, tiers } = await setup();
  const c = await pick(tiers.subagent, { sessionKey: "sub-2", excludeConnectionIds: [team.id] });
  assert.equal(c.connectionId, pro.id);
});

test("tiers: the whole pool out sends a sub-agent to main", async () => {
  const { max, team, pro, tiers } = await setup();
  const c = await pick(tiers.subagent, {
    sessionKey: "sub-3",
    excludeConnectionIds: [team.id, pro.id],
  });
  assert.equal(c.connectionId, max.id);
});

test("tiers: a busy main account does not spill a main chat onto the pool", async () => {
  const { max, tiers } = await setup();
  const releases = ["a", "b", "c", "d", "e"].map((s) =>
    oauthOccupancy.reserveOAuthSession(max.id, `other-${s}`, 60_000)
  );
  const c = await pick(tiers.main, { sessionKey: "main-3" });
  assert.equal(c.connectionId, max.id);
  c.releaseOAuthSession?.();
  releases.forEach((r) => r());
});

test("tiers: a sub-agent stays on the pool account it started on after a brief cooldown elsewhere", async () => {
  const { team, pro, tiers } = await setup();
  const opts = { sessionKey: "sub-4", sessionAffinityTtlMs: 7_200_000 };
  await providersDb.updateProviderConnection(team.id, {
    rateLimitedUntil: new Date(Date.now() + 60_000).toISOString(),
  });
  const first = await pick(tiers.subagent, opts);
  first.releaseOAuthSession?.();
  await providersDb.updateProviderConnection(team.id, { rateLimitedUntil: null });
  const second = await pick(tiers.subagent, opts);
  second.releaseOAuthSession?.();
  assert.equal(first.connectionId, pro.id);
  assert.equal(second.connectionId, pro.id, "went back to team: a second full rewrite");
});

test("no tiers: selection is unchanged (fill-first picks priority 1)", async () => {
  const { max } = await setup();
  const c = await auth.getProviderCredentials("claude", null, null, "claude-opus-5-5", {
    sessionKey: "plain-1",
  });
  assert.equal(c.connectionId, max.id);
});
