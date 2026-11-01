/**
 * ZAC-272: Copilot rewrites the <session_context> block (checkpoint count and titles) some
 * calls after a compaction. Everything after it in the cache was written again for nothing
 * (14 of 21 mid-chat system-prompt changes, Oct 29 - Nov 1). The freeze replays a chat's
 * first <session_context> block until the history's first message changes (a compaction),
 * which breaks the cache anyway.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  freezeSessionContext,
  createMemorySessionContextStore,
} from "../../open-sse/services/claudeSessionContextFreeze.ts";

type Block = { type: string; text?: string; cache_control?: unknown };
type Body = Record<string, unknown> & { system: Block[]; messages: unknown[] };

const ON = { OMNIROUTE_CLAUDE_FREEZE_SESSION_CONTEXT: "1" } as NodeJS.ProcessEnv;
const BILLING = { type: "text", text: "x-anthropic-billing-header: cc_version=1; cch=00000;" };
const SENTINEL = {
  type: "text",
  text: "You are Claude Code, Anthropic's official CLI for Claude.",
};
const HEAD = "You are an AI assistant.\n* Current working directory: /x\n<rules>r</rules>\n";
const TAIL = "\n<formatting>be nice</formatting>";

function ctx(session: string, checkpoints: number): string {
  return (
    `<session_context>\nSession folder: /h/.copilot/session-state/${session}\n\n` +
    `Contents:\n- checkpoints/: ${checkpoints} prior checkpoints\n</session_context>`
  );
}

function body(opts: {
  session?: string;
  checkpoints?: number;
  head?: string;
  first?: string;
}): Body {
  const { session = "s1", checkpoints = 1, head = HEAD, first = "hello" } = opts;
  return {
    system: [
      { ...BILLING },
      { ...SENTINEL },
      { type: "text", text: head + ctx(session, checkpoints) + TAIL },
    ],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: first, cache_control: { type: "ephemeral" } }],
      },
      { role: "assistant", content: "ok" },
    ],
  };
}

const clientText = (b: Body) => b.system[2].text as string;

test("off by default: the body is not touched", () => {
  const store = createMemorySessionContextStore();
  freezeSessionContext(body({ checkpoints: 1 }), { store, env: {} });
  const b = body({ checkpoints: 2 });
  const r = freezeSessionContext(b, { store, env: {} });
  assert.equal(r.action, "off");
  assert.ok(clientText(b).includes("2 prior checkpoints"));
});

test("first call stores the block and sends it unchanged", () => {
  const store = createMemorySessionContextStore();
  const b = body({});
  const before = JSON.stringify(b);
  const r = freezeSessionContext(b, { store, env: ON });
  assert.equal(r.action, "stored");
  assert.equal(JSON.stringify(b), before);
});

test("a later checkpoint change in the same chat replays the first block", () => {
  const store = createMemorySessionContextStore();
  freezeSessionContext(body({ checkpoints: 1 }), { store, env: ON });
  const b = body({ checkpoints: 2 });
  const r = freezeSessionContext(b, { store, env: ON });
  assert.equal(r.action, "replayed");
  assert.equal(clientText(b), HEAD + ctx("s1", 1) + TAIL);
});

test("only the session_context block changes: head and tail are the client's own", () => {
  const store = createMemorySessionContextStore();
  freezeSessionContext(body({ checkpoints: 1 }), { store, env: ON });
  const b = body({ checkpoints: 3 });
  b.system[2].text = clientText(b).replace("be nice", "be kind");
  freezeSessionContext(b, { store, env: ON });
  assert.ok(clientText(b).endsWith("<formatting>be kind</formatting>"));
  assert.ok(clientText(b).includes("1 prior checkpoints"));
});

test("a compaction (new first message) takes the new block", () => {
  const store = createMemorySessionContextStore();
  freezeSessionContext(body({ checkpoints: 1 }), { store, env: ON });
  const b = body({ checkpoints: 2, first: "Some of the conversation history has been summarized" });
  const r = freezeSessionContext(b, { store, env: ON });
  assert.equal(r.action, "refreshed");
  assert.ok(clientText(b).includes("2 prior checkpoints"));
  // and that new block is what later calls replay
  const c = body({ checkpoints: 3, first: "Some of the conversation history has been summarized" });
  freezeSessionContext(c, { store, env: ON });
  assert.ok(clientText(c).includes("2 prior checkpoints"));
});

test("cache_control moving on the first message is not a compaction", () => {
  const store = createMemorySessionContextStore();
  freezeSessionContext(body({ checkpoints: 1 }), { store, env: ON });
  const b = body({ checkpoints: 2 });
  (b.messages[0] as { content: Block[] }).content[0].cache_control = undefined;
  delete (b.messages[0] as { content: Block[] }).content[0].cache_control;
  assert.equal(freezeSessionContext(b, { store, env: ON }).action, "replayed");
});

test("another chat (other session folder) never gets this chat's block", () => {
  const store = createMemorySessionContextStore();
  freezeSessionContext(body({ session: "s1", checkpoints: 1 }), { store, env: ON });
  const b = body({ session: "s2", checkpoints: 5 });
  assert.equal(freezeSessionContext(b, { store, env: ON }).action, "stored");
  assert.ok(clientText(b).includes("s2") && clientText(b).includes("5 prior checkpoints"));
});

test("a subagent (different prompt start, same session folder) never gets the parent's block", () => {
  const store = createMemorySessionContextStore();
  freezeSessionContext(body({ checkpoints: 1 }), { store, env: ON });
  const b = body({ checkpoints: 2, head: "You are a subagent.\n" });
  assert.equal(freezeSessionContext(b, { store, env: ON }).action, "stored");
  assert.ok(clientText(b).includes("2 prior checkpoints"));
});

test("an edit before the block (AGENTS.md, memory) still reaches the chat", () => {
  const store = createMemorySessionContextStore();
  freezeSessionContext(body({ checkpoints: 1 }), { store, env: ON });
  const edited = HEAD.replace("<rules>r</rules>", "<rules>new rule</rules>");
  const b = body({ checkpoints: 2, head: edited });
  freezeSessionContext(b, { store, env: ON });
  assert.ok(clientText(b).startsWith(edited));
});

test("no session_context block, or no Session folder line: nothing happens", () => {
  const store = createMemorySessionContextStore();
  const b = body({});
  b.system[2].text = HEAD + TAIL;
  assert.equal(freezeSessionContext(b, { store, env: ON }).action, "none");
  const c = body({});
  c.system[2].text = HEAD + "<session_context>\nno folder\n</session_context>" + TAIL;
  assert.equal(freezeSessionContext(c, { store, env: ON }).action, "none");
});

test("a store that throws never breaks the request", () => {
  const store = {
    get() {
      throw new Error("db locked");
    },
    set() {
      throw new Error("db locked");
    },
    deleteSession() {
      return 0;
    },
  };
  const b = body({ checkpoints: 2 });
  const before = JSON.stringify(b);
  const r = freezeSessionContext(b, { store, env: ON });
  assert.equal(r.action, "error");
  assert.equal(JSON.stringify(b), before);
});

test("deleteSession forces the next call to take the current block", () => {
  const store = createMemorySessionContextStore();
  freezeSessionContext(body({ checkpoints: 1 }), { store, env: ON });
  assert.equal(store.deleteSession("s1"), 1);
  const b = body({ checkpoints: 2 });
  assert.equal(freezeSessionContext(b, { store, env: ON }).action, "stored");
  assert.ok(clientText(b).includes("2 prior checkpoints"));
});

test("an expired snapshot is treated as missing", () => {
  const store = createMemorySessionContextStore();
  const t0 = Date.parse("2026-11-01T00:00:00Z");
  freezeSessionContext(body({ checkpoints: 1 }), { store, env: ON, now: t0 });
  const b = body({ checkpoints: 2 });
  const r = freezeSessionContext(b, { store, env: ON, now: t0 + 8 * 86_400_000 });
  assert.equal(r.action, "stored");
  assert.ok(clientText(b).includes("2 prior checkpoints"));
});

test("the SQLite store round-trips, purges expired rows and deletes by session", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { createSqliteSessionContextStore } =
    await import("../../open-sse/services/claudeSessionContextFreeze.ts");
  const db = new Database(":memory:");
  const store = createSqliteSessionContextStore(db);
  const t0 = Date.parse("2026-11-01T00:00:00Z");
  freezeSessionContext(body({ session: "old", checkpoints: 1 }), { store, env: ON, now: t0 });
  freezeSessionContext(body({ checkpoints: 1 }), { store, env: ON, now: t0 + 8 * 86_400_000 });
  const count = () =>
    (
      db.prepare("SELECT count(*) AS n FROM claude_session_context_snapshots").get() as {
        n: number;
      }
    ).n;
  assert.equal(count(), 1, "the expired 'old' row was purged on the next write");
  const b = body({ checkpoints: 2 });
  assert.equal(
    freezeSessionContext(b, { store, env: ON, now: t0 + 8 * 86_400_000 }).action,
    "replayed"
  );
  assert.ok(clientText(b).includes("1 prior checkpoints"));
  assert.equal(store.deleteSession("s1"), 1);
  assert.equal(count(), 0);
  // a second store on the same db (restart) keeps working: CREATE TABLE IF NOT EXISTS
  createSqliteSessionContextStore(db);
});
