import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";

const harness = await createChatPipelineHarness("claude-role-tiers");
const { BaseExecutor, buildRequest, handleChat, resetStorage } = harness;
const providersDb = await import("../../src/lib/db/providers.ts");
after(() => {
  delete process.env.OMNIROUTE_CLAUDE_ROLE_TIERS;
  harness.cleanup();
});

async function setup() {
  BaseExecutor.RETRY_CONFIG.delayMs = 0;
  await resetStorage();
  const mk = (name: string, priority: number) =>
    providersDb.createProviderConnection({
      provider: "claude",
      authType: "oauth",
      name,
      accessToken: `sk-ant-oat-${name}`,
      refreshToken: `rt-${name}`,
      isActive: true,
      testStatus: "active",
      priority,
    });
  const max = await mk("max", 1);
  const team = await mk("team", 2);
  process.env.OMNIROUTE_CLAUDE_ROLE_TIERS = JSON.stringify({ main: [max.id], subagent: [team.id] });
  return { max, team };
}

function capture() {
  const tokens: string[] = [];
  globalThis.fetch = async (_input: unknown, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("authorization") || "";
    // bootstrap / usage side calls are not the chat
    if (String(_input).includes("/v1/messages")) tokens.push(auth.replace(/^Bearer\s+/i, ""));
    return new Response(
      JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  return tokens;
}

const tool = (name: string) => ({
  type: "function",
  function: { name, description: name, parameters: { type: "object", properties: {} } },
});
const chat = (tools: unknown[]) =>
  buildRequest({
    body: {
      model: "claude/claude-opus-5-5",
      stream: false,
      max_tokens: 4,
      messages: [{ role: "user", content: `hi ${Math.random()}` }],
      tools,
    },
  });

test("a main chat (ask_user in its tools) is served by the main account", async () => {
  await setup();
  const tokens = capture();
  const res = await handleChat(chat([tool("bash"), tool("ask_user")]));
  assert.equal(res.status, 200, await res.text());
  assert.deepEqual(tokens, ["sk-ant-oat-max"]);
});

test("a sub-agent (no ask_user) is served by the pool account", async () => {
  await setup();
  const tokens = capture();
  const res = await handleChat(chat([tool("bash"), tool("task")]));
  assert.equal(res.status, 200, await res.text());
  assert.deepEqual(tokens, ["sk-ant-oat-team"]);
});

test("without the env the sub-agent goes where fill-first sends it (main, priority 1)", async () => {
  await setup();
  delete process.env.OMNIROUTE_CLAUDE_ROLE_TIERS;
  const tokens = capture();
  const res = await handleChat(chat([tool("bash")]));
  assert.equal(res.status, 200, await res.text());
  assert.deepEqual(tokens, ["sk-ant-oat-max"]);
});

test("a keep-warm ping pinned to the main account stays there (tiers don't apply)", async () => {
  const { max } = await setup();
  const tokens = capture();
  const res = await handleChat(
    buildRequest({
      body: {
        model: "claude/claude-opus-5-5",
        stream: false,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
        tools: [tool("bash")],
      },
      headers: { "x-omniroute-keepwarm": "1", "x-omniroute-connection": max.id },
    })
  );
  assert.equal(res.status, 200, await res.text());
  assert.deepEqual(tokens, ["sk-ant-oat-max"]);
});
