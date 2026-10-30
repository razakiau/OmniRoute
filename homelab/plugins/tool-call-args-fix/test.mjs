// Tests for the tool-call-args-fix plugin. No dependencies: `node test.mjs`.
// Runs on the controller (scripts/test-omniroute-plugins.sh) and against the
// deployed copy inside the container, so the node that runs the plugin is the
// node that tested it.
import assert from "node:assert/strict";
import { onRequest, normalizeArguments } from "./index.mjs";

let n = 0;
const t = (name, fn) => { fn(); n++; };

const call = (id, args) => ({ id, type: "function", function: { name: "list_teams", arguments: args } });
const req = (calls, provider = "claude") => ({
  provider,
  body: {
    model: "claude-opus-5-5",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "Checking.", tool_calls: calls },
      ...calls.map((c) => ({ role: "tool", tool_call_id: c.id, content: "{}" })),
    ],
  },
});
const argsOf = (result) => result.body.messages[1].tool_calls.map((c) => c.function.arguments);

// --- normalizeArguments: what Anthropic accepts is a JSON object -------------
t("empty string becomes {}", () => assert.equal(normalizeArguments(""), "{}"));
t("whitespace becomes {}", () => assert.equal(normalizeArguments("  \n"), "{}"));
t("undefined becomes {}", () => assert.equal(normalizeArguments(undefined), "{}"));
t("null becomes {}", () => assert.equal(normalizeArguments(null), "{}"));
t("JSON null becomes {}", () => assert.equal(normalizeArguments("null"), "{}"));
t("an object value is serialised", () => assert.equal(normalizeArguments({ a: 1 }), '{"a":1}'));
t("a valid object string is unchanged", () => assert.equal(normalizeArguments('{"limit":5}'), '{"limit":5}'));
t("{} is unchanged", () => assert.equal(normalizeArguments("{}"), "{}"));
// Left alone on purpose: the model produced them, and turning them into {}
// would silently change what the call meant. They still fail upstream, loudly.
t("a JSON array is left alone", () => assert.equal(normalizeArguments("[1]"), "[1]"));
t("a JSON string is left alone", () => assert.equal(normalizeArguments('"x"'), '"x"'));
t("truncated JSON is left alone", () => assert.equal(normalizeArguments('{"a":'), '{"a":'));

// --- onRequest ---------------------------------------------------------------
t("the failing shape is repaired, the good call untouched", () => {
  const r = onRequest(req([call("a", '{"query":"me"}'), call("b", "")]));
  assert.deepEqual(argsOf(r), ['{"query":"me"}', "{}"]);
  assert.deepEqual(r.metadata, { toolCallArgsNormalized: 1 });
});
t("every empty call in every assistant turn is repaired", () => {
  const ctx = req([call("a", ""), call("b", "null")]);
  ctx.body.messages.push({ role: "assistant", content: null, tool_calls: [call("c", undefined)] });
  const r = onRequest(ctx);
  assert.deepEqual(argsOf(r), ["{}", "{}"]);
  assert.equal(r.body.messages.at(-1).tool_calls[0].function.arguments, "{}");
  assert.equal(r.metadata.toolCallArgsNormalized, 3);
});
t("a clean request returns void (body passes through untouched)", () => {
  assert.equal(onRequest(req([call("a", '{"x":1}'), call("b", "{}")])), undefined);
});
t("the input body is not mutated", () => {
  const ctx = req([call("a", "")]);
  const before = JSON.stringify(ctx.body);
  onRequest(ctx);
  assert.equal(JSON.stringify(ctx.body), before);
});
t("applies to every provider (the Claude translator is not claude-only)", () => {
  for (const p of ["claude", "github", "devin-cli-agentic", "anthropic-compatible-x", "opencode-go"]) {
    assert.deepEqual(argsOf(onRequest(req([call("a", "")], p))), ["{}"]);
  }
});
t("malformed shapes are ignored, never thrown on", () => {
  for (const ctx of [undefined, null, {}, { body: null }, { body: { messages: "x" } },
    { body: { messages: [null, 1, "s", { role: "assistant", tool_calls: "x" }] } },
    { body: { messages: [{ role: "assistant", tool_calls: [null, { function: null }, { type: "function" }] }] } }]) {
    assert.equal(onRequest(ctx), undefined);
  }
});
t("a call with no function object is left alone", () => {
  const ctx = { body: { messages: [{ role: "assistant", tool_calls: [{ id: "a", type: "function" }] }] } };
  assert.equal(onRequest(ctx), undefined);
});

console.log(`tool-call-args-fix: ${n} tests passed`);
