// ZAC-267 (homelab): a keep-warm ping pinned to its account, end to end through handleChat.
// A model mapped to a combo (as claude/<m> → <m>-paid-fallback is in the homelab) must go
// straight to the pinned connection, never through the combo, never to a sibling account,
// and never revive an inactive one. Unpinned traffic keeps using the combo.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";

const harness = await createChatPipelineHarness("keepwarm-pinned-ping");
const {
  BaseExecutor,
  buildOpenAIResponse,
  buildRequest,
  combosDb,
  handleChat,
  modelComboMappingsDb,
  resetStorage,
} = harness;
const providersDb = await import("../../src/lib/db/providers.ts");
const { persistDiscoveredModels } = await import("../../src/lib/providerModels/modelDiscovery.ts");
after(() => harness.cleanup());

const MODEL = "kw-pin-model";
async function setup() {
  BaseExecutor.RETRY_CONFIG.delayMs = 0;
  await resetStorage();
  const mk = (name: string, apiKey: string, priority: number, isActive = true) =>
    providersDb.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name,
      apiKey,
      isActive,
      testStatus: "active",
      priority,
    });
  const ultra = await mk("ultra", "sk-ultra", 2);
  const pro = await mk("pro", "sk-pro", 1);
  const off = await mk("pro-off", "sk-pro-off", 3, false);
  for (const c of [ultra, pro, off])
    await persistDiscoveredModels("openai", c.id, [{ id: MODEL, name: MODEL }]);
  // the combo's second target is another provider: a failover would show up as a call there
  const combo = await combosDb.createCombo({
    name: `kw-pin-combo-${Date.now()}`,
    strategy: "priority",
    models: [
      { kind: "model", model: `openai/${MODEL}` },
      { kind: "model", model: `anthropic/${MODEL}` },
    ],
  });
  await modelComboMappingsDb.createModelComboMapping({
    pattern: `openai/${MODEL}`,
    comboId: combo.id,
  });
  return { ultra, pro, off };
}
// The real ping's answer: a stream that ends on the token limit with no visible text
// (Opus spent it thinking). A combo's quality check fails that over; the direct path must not.
const emptyStream = () => {
  const enc = new TextEncoder();
  const chunks = [
    {
      id: "c1",
      object: "chat.completion.chunk",
      model: MODEL,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    },
    {
      id: "c1",
      object: "chat.completion.chunk",
      model: MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: "length" }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    },
  ];
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(enc.encode(body), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
};
function capture(status = 200) {
  const keys: string[] = [];
  globalThis.fetch = async (_input: unknown, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    keys.push(
      String(h.get("authorization") || "")
        .split(" ")
        .pop() || ""
    );
    return status === 200
      ? emptyStream()
      : new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status,
          headers: { "content-type": "application/json" },
        });
  };
  return keys;
}
const ping = (connectionId: string | null, marker = true) =>
  buildRequest({
    body: {
      model: `openai/${MODEL}`,
      stream: true,
      max_tokens: 4,
      messages: [{ role: "user", content: "hi" }],
    },
    headers: {
      ...(marker ? { "x-omniroute-keepwarm": "1" } : {}),
      ...(connectionId ? { "x-omniroute-connection": connectionId } : {}),
    },
  });

test("a pinned keep-warm ping goes only to its connection, outside the combo", async () => {
  const { pro, ultra } = await setup();
  // each pin lands on its own account, whatever the pool would have picked, and the empty
  // answer is not failed over to the combo's next target
  for (const [conn, key] of [
    [pro, "sk-pro"],
    [ultra, "sk-ultra"],
    [pro, "sk-pro"],
  ] as const) {
    const keys = capture();
    const res = await handleChat(ping(conn.id));
    const text = await res.text();
    assert.equal(res.status, 200, text);
    assert.deepEqual(keys, [key]);
  }
});

test("a pinned keep-warm ping whose account fails gets no sibling account", async () => {
  const { pro } = await setup();
  const keys = capture(429);
  const res = await handleChat(ping(pro.id));
  assert.notEqual(res.status, 200);
  assert.ok(keys.length >= 1 && keys.every((k) => k === "sk-pro"), JSON.stringify(keys));
});

test("a pinned keep-warm ping never revives an inactive account", async () => {
  const { off } = await setup();
  const keys = capture();
  const res = await handleChat(ping(off.id));
  assert.notEqual(res.status, 200);
  assert.deepEqual(keys, []);
  const row = await providersDb.getProviderConnectionById(off.id);
  assert.equal(row?.isActive, false);
});

test("without the keep-warm marker the request keeps the combo (unchanged)", async () => {
  await setup();
  const keys = capture();
  const res = await handleChat(ping(null, false));
  // unchanged upstream behaviour: the combo's quality check rejects the empty answer and fails
  // over to the next target (no anthropic connection here, so the combo ends in an error)
  assert.notEqual(res.status, 200);
  assert.equal(keys.length, 1, JSON.stringify(keys));
});
