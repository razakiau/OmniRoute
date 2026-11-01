import test from "node:test";
import assert from "node:assert/strict";

import {
  parseRoleTiers,
  requestRole,
  tiersForRequest,
  narrowToFirstTier,
} from "../../src/sse/services/claudeRoleTiers.ts";

const CONFIG = { main: ["max"], subagent: ["team", "pro"] };
const openaiTool = (name: string) => ({ type: "function", function: { name, parameters: {} } });
const anthropicTool = (name: string) => ({ name, input_schema: { type: "object" } });

test("role: ask_user in OpenAI-style tools is a main chat", () => {
  assert.equal(requestRole({ tools: [openaiTool("bash"), openaiTool("ask_user")] }), "main");
});

test("role: ask_user in Anthropic-style tools is a main chat", () => {
  assert.equal(requestRole({ tools: [anthropicTool("ask_user")] }), "main");
});

test("role: tools without ask_user, or no tools, is a sub-agent", () => {
  assert.equal(requestRole({ tools: [openaiTool("bash"), openaiTool("task")] }), "subagent");
  assert.equal(requestRole({ messages: [] }), "subagent");
  assert.equal(requestRole(null), "subagent");
});

test("parse: valid JSON keeps both lists, trimmed, empties dropped", () => {
  assert.deepEqual(parseRoleTiers('{"main":[" max "],"subagent":["team","","pro"]}'), CONFIG);
});

test("parse: unset, empty, malformed or both lists empty turn the feature off", () => {
  assert.equal(parseRoleTiers(undefined), null);
  assert.equal(parseRoleTiers(""), null);
  assert.equal(parseRoleTiers("{not json"), null);
  assert.equal(parseRoleTiers('{"main":"max"}'), null);
  assert.equal(parseRoleTiers('{"main":[],"subagent":[]}'), null);
});

test("tiers: main tries its own tier first, then the pool", () => {
  assert.deepEqual(tiersForRequest("claude", { tools: [openaiTool("ask_user")] }, CONFIG), [
    ["max"],
    ["team", "pro"],
  ]);
});

test("tiers: a sub-agent tries the pool first, then main", () => {
  assert.deepEqual(tiersForRequest("claude", { tools: [openaiTool("bash")] }, CONFIG), [
    ["team", "pro"],
    ["max"],
  ]);
});

test("tiers: other providers and no config leave selection alone", () => {
  assert.equal(tiersForRequest("codex", { tools: [] }, CONFIG), null);
  assert.equal(tiersForRequest("claude", { tools: [] }, null), null);
});

const conns = (...ids: string[]) => ids.map((id) => ({ id }));

test("narrow: keeps only the first tier that has a candidate", () => {
  const tiers = [["team", "pro"], ["max"]];
  assert.deepEqual(narrowToFirstTier(conns("max", "pro", "team"), tiers), conns("pro", "team"));
  assert.deepEqual(narrowToFirstTier(conns("max", "pro"), tiers), conns("pro"));
});

test("narrow: falls to the next tier when the first has none left", () => {
  assert.deepEqual(narrowToFirstTier(conns("max"), [["team", "pro"], ["max"]]), conns("max"));
});

test("narrow: accounts in no tier are the last resort", () => {
  const tiers = [["team"], ["max"]];
  assert.deepEqual(narrowToFirstTier(conns("other", "max"), tiers), conns("max"));
  assert.deepEqual(narrowToFirstTier(conns("other"), tiers), conns("other"));
  assert.deepEqual(narrowToFirstTier([], tiers), []);
});
