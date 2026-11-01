/**
 * ZAC-263: signRequestBody replaced the FIRST "cch=xxxxx;" anywhere in the body. A chat
 * whose history quotes such text (here: OmniRoute source pasted in a tool result) had
 * that message rewritten with a per-request hash on every call, so its cache broke at
 * that message every call (~250K written per call) and the billing line stayed unsigned.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { signRequestBody } from "../../open-sse/services/claudeCodeCCH.ts";

const QUOTED = "const billingLine = `x-anthropic-billing-header: cc_version=1; cch=00000;`; cch=fc1d8;";

function body() {
  return {
    messages: [{ role: "user", content: [{ type: "tool_result", content: QUOTED }] }],
    system: [{ type: "text", text: "x-anthropic-billing-header: cc_version=2.1.0; cc_entrypoint=cli; cch=00000;" }],
  };
}

test("signs the billing line, not text quoted in the history", async () => {
  const signed = JSON.parse(await signRequestBody(JSON.stringify(body())));
  assert.equal(signed.messages[0].content[0].content, QUOTED);
  assert.match(signed.system[0].text, /cch=[0-9a-f]{5};$/);
  assert.doesNotMatch(signed.system[0].text, /cch=00000;/);
});

test("the same body signs the same way twice (history stays byte-stable)", async () => {
  const a = await signRequestBody(JSON.stringify(body()));
  const b = await signRequestBody(JSON.stringify(body()));
  assert.equal(a, b);
});

test("a body without a billing line is left alone", async () => {
  const s = JSON.stringify({ messages: [{ role: "user", content: QUOTED }] });
  assert.equal(await signRequestBody(s), s);
});
