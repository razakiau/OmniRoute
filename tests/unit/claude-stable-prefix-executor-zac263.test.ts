/**
 * ZAC-263 on the real executor path: the native Claude OAuth step must send the two
 * stable-prefix breakpoints on the client's system text, keep the text, keep signing,
 * leave the caller's body alone (#16631), and send today's body with the switch off.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getExecutor } from "../../open-sse/executors/index.ts";

type Body = Record<string, unknown>;
type Block = { type?: string; text?: string; cache_control?: unknown };

const CC = { type: "ephemeral", ttl: "1h" };
const SYSTEM_TEXT =
  "You are an AI assistant.\n<environment_context>\n" +
  "\n* Current working directory: /Users/me/repo\n* Git repository root: /Users/me/repo\n" +
  "<rules>use the tools</rules>\n\n" +
  "<session_context>\nSession folder: /Users/me/.copilot/session-state/abc\n</session_context>\n" +
  "<formatting>links</formatting>";

function translatedBody(): Body {
  return {
    model: "claude-opus-4-8",
    max_tokens: 1024,
    system: [{ type: "text", text: SYSTEM_TEXT, cache_control: { ...CC } }],
    tools: [
      { name: "bash", description: "run", input_schema: { type: "object" } },
      {
        name: "edit",
        description: "edit",
        input_schema: { type: "object" },
        cache_control: { ...CC },
      },
    ],
    messages: [
      { role: "user", content: [{ type: "text", text: "hello", cache_control: { ...CC } }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_1", name: "bash", input: {}, cache_control: { ...CC } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
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
      model: "claude-opus-4-8",
      body,
      stream: false,
      credentials: { accessToken: "sk-ant-oat-test-zac263" },
      clientHeaders: { "x-app": "cli", "x-omniroute-effort": "off" },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(upstream, "the executor must have called fetch");
  return upstream!;
}

function marks(b: Body): number {
  let n = 0;
  const c = (x: unknown) => {
    if (x && typeof x === "object" && (x as Block).cache_control !== undefined) n++;
  };
  (b.system as unknown[]).forEach(c);
  (b.tools as unknown[]).forEach(c);
  for (const m of b.messages as Array<{ content: unknown }>) {
    if (Array.isArray(m.content)) m.content.forEach(c);
  }
  return n;
}

const clientText = (b: Body) =>
  (b.system as Block[])
    .slice(2)
    .map((x) => x.text)
    .join("");

afterEach(() => {
  delete process.env.OMNIROUTE_CLAUDE_STABLE_PREFIX_BREAKPOINTS;
});

test("stable-prefix: two new breakpoints in the signed body", async () => {
  const up = await send(translatedBody());
  const sys = up.system as Block[];
  assert.equal(sys[0].cache_control, undefined, "billing line unmarked");
  assert.equal(sys[1].cache_control, undefined, "sentinel unmarked");
  const marked = sys.slice(2).filter((b) => b.cache_control !== undefined);
  assert.equal(marked.length, 2);
  assert.ok(sys[3].text!.startsWith("\n* Current working directory:"));
  assert.deepEqual(sys[2].cache_control, CC);
  assert.ok(sys[4].text!.startsWith("<session_context>"));
  assert.deepEqual(sys[3].cache_control, CC);
  for (const t of up.tools as Block[]) assert.equal(t.cache_control, undefined, "no tool marked");
  assert.ok(marks(up) <= 4, `breakpoints: ${marks(up)}`);
});

test("stable-prefix: text arrives unchanged", async () => {
  const on = await send(translatedBody());
  process.env.OMNIROUTE_CLAUDE_STABLE_PREFIX_BREAKPOINTS = "0";
  const off = await send(translatedBody());
  assert.equal(clientText(on), clientText(off));
  assert.ok(clientText(on).includes("<session_context>"));
});

test("stable-prefix: cch still signed after the split", async () => {
  const up = await send(translatedBody());
  const billing = String((up.system as Block[])[0].text);
  assert.match(billing, /cch=[0-9a-f]{5};/);
  assert.doesNotMatch(billing, /cch=00000;/);
});

test("stable-prefix: the caller's body is left alone (#16631)", async () => {
  const body = translatedBody();
  const before = structuredClone(body);
  await send(body);
  assert.deepEqual(body, before);
});

test("stable-prefix: trimming to 4 keeps the caller's message markers (#16631)", async () => {
  const body = translatedBody();
  const last = (body.messages as Array<{ content: Block[] }>)[2].content[0];
  last.cache_control = { ...CC };
  const before = structuredClone(body);
  const up = await send(body);
  assert.ok(marks(up) <= 4, `breakpoints: ${marks(up)}`);
  const upLast = (up.messages as Array<{ content: Block[] }>)[2].content[0];
  assert.deepEqual(upLast.cache_control, CC, "latest message marker survives");
  assert.deepEqual(body, before);
});

test("stable-prefix: switch off sends one client system block, as before", async () => {
  process.env.OMNIROUTE_CLAUDE_STABLE_PREFIX_BREAKPOINTS = "0";
  const up = await send(translatedBody());
  const sys = up.system as Block[];
  // The system-transform pipeline (ZWJ obfuscation, paragraph drops) still rewrites the
  // text as it always has; only the block layout is ours to check.
  assert.equal(sys.length, 3);
  assert.ok(String(sys[2].text).includes("<session_context>"));
  assert.deepEqual(sys[2].cache_control, CC);
});
