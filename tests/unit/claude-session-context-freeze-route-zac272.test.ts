/**
 * ZAC-272: DELETE /api/cache/session-context?session=<id> drops one chat's frozen block,
 * needs a management key when login is required, and rejects anything but a folder name.
 */
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "zac272-route-test-secret";
// A fresh test DB has no password, which leaves management routes open (onboarding).
process.env.INITIAL_PASSWORD = process.env.INITIAL_PASSWORD || "zac272-route-test-password";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { DELETE } from "../../src/app/api/cache/session-context/route.ts";
import { createApiKey } from "../../src/lib/db/apiKeys.ts";
import { updateSettings } from "../../src/lib/db/settings";
import {
  freezeSessionContext,
  getDefaultSessionContextStore,
} from "../../open-sse/services/claudeSessionContextFreeze.ts";

const ON = { OMNIROUTE_CLAUDE_FREEZE_SESSION_CONTEXT: "1" } as NodeJS.ProcessEnv;
let key = "";

function body(session: string, n: number) {
  return {
    system: [
      { type: "text", text: "billing" },
      { type: "text", text: "sentinel" },
      {
        type: "text",
        text: `Hi\n<session_context>\nSession folder: /h/${session}\n${n} prior checkpoints\n</session_context>`,
      },
    ],
    messages: [{ role: "user", content: "hello" }],
  };
}

const req = (q: string, auth = true) =>
  new Request(`http://localhost/api/cache/session-context${q}`, {
    method: "DELETE",
    headers: auth ? { authorization: `Bearer ${key}` } : {},
  }) as never;

before(async () => {
  await updateSettings({ requireLogin: true });
  key = (await createApiKey("zac272-route-test", "machine-zac272", ["manage"])).key;
});

after(async () => {
  await updateSettings({ requireLogin: true });
});

test("without a key: 401, snapshot kept", async () => {
  const store = getDefaultSessionContextStore();
  freezeSessionContext(body("route-a", 1), { store, env: ON });
  const res = await DELETE(req("?session=route-a", false));
  assert.equal(res.status, 401);
  const b = body("route-a", 2);
  assert.equal(freezeSessionContext(b, { store, env: ON }).action, "replayed");
});

test("with a management key: the snapshot is dropped and the next call takes the new block", async () => {
  const store = getDefaultSessionContextStore();
  freezeSessionContext(body("route-b", 1), { store, env: ON });
  const res = await DELETE(req("?session=route-b"));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, session: "route-b", removed: 1 });
  const b = body("route-b", 2);
  assert.equal(freezeSessionContext(b, { store, env: ON }).action, "stored");
  assert.ok(String(b.system[2].text).includes("2 prior checkpoints"));
});

test("bad or missing session: 400", async () => {
  assert.equal((await DELETE(req(""))).status, 400);
  assert.equal((await DELETE(req("?session=../etc"))).status, 400);
  assert.equal((await DELETE(req("?session=a%20b"))).status, 400);
});
