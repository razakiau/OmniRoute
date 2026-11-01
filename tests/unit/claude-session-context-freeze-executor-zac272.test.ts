/**
 * ZAC-272 on the real executor path: with the freeze on, a chat's second call sends its
 * first <session_context> block even though the client sent a newer one, and the ZAC-263
 * breakpoints still sit before the block. Off (the default), the client's block is sent.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getExecutor } from "../../open-sse/executors/index.ts";

type Body = Record<string, unknown>;
type Block = { type?: string; text?: string; cache_control?: unknown };

const CC = { type: "ephemeral", ttl: "1h" };
let seq = 0;

function systemText(session: string, checkpoints: number): string {
  return (
    "You are an AI assistant.\n<environment_context>\n" +
    "\n* Current working directory: /Users/me/repo\n" +
    "<rules>use the tools</rules>\n\n" +
    `<session_context>\nSession folder: /Users/me/.copilot/session-state/${session}\n` +
    `- checkpoints/: ${checkpoints} prior checkpoints\n</session_context>\n` +
    "<formatting>links</formatting>"
  );
}

function translatedBody(session: string, checkpoints: number): Body {
  return {
    model: "claude-haiku-4-5",
    max_tokens: 64,
    system: [{ type: "text", text: systemText(session, checkpoints), cache_control: { ...CC } }],
    messages: [
      { role: "user", content: [{ type: "text", text: "hello", cache_control: { ...CC } }] },
    ],
  };
}

async function send(body: Body): Promise<Body> {
  const executor = await getExecutor("claude");
  const originalFetch = globalThis.fetch;
  let upstream: Body | null = null;
  globalThis.fetch = async (_url: string | URL | Request, init: RequestInit = {}) => {
    upstream = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ id: "msg_1", type: "message", content: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    await executor.execute({
      model: "claude-haiku-4-5",
      body,
      stream: false,
      credentials: { accessToken: "sk-ant-oat-test-zac272" },
      clientHeaders: { "x-app": "cli", "x-omniroute-effort": "off" },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(upstream, "the executor must have called fetch");
  return upstream!;
}

const clientText = (b: Body) =>
  (b.system as Block[])
    .slice(2)
    .map((x) => x.text)
    .join("");

afterEach(() => {
  delete process.env.OMNIROUTE_CLAUDE_FREEZE_SESSION_CONTEXT;
});

test("freeze on: the second call replays the first block, breakpoints intact", async () => {
  process.env.OMNIROUTE_CLAUDE_FREEZE_SESSION_CONTEXT = "1";
  const session = `exec-${process.pid}-${++seq}`;
  await send(translatedBody(session, 1));
  const body = translatedBody(session, 2);
  const before = structuredClone(body);
  const up = await send(body);
  assert.ok(clientText(up).includes("1 prior checkpoints"), "frozen block sent");
  assert.ok(!clientText(up).includes("2 prior checkpoints"));
  const sys = up.system as Block[];
  assert.ok(
    sys.some((b) => b.text?.startsWith("<session_context>")),
    "split before the block"
  );
  assert.deepEqual(body, before, "the caller's body is left alone (#16631)");
});

test("freeze off (default): the client's newer block is sent", async () => {
  const session = `exec-${process.pid}-${++seq}`;
  await send(translatedBody(session, 1));
  const up = await send(translatedBody(session, 2));
  assert.ok(clientText(up).includes("2 prior checkpoints"));
});
