// ZAC-106 (homelab): these Go models only answer on the Responses endpoint;
// Chat Completions gets "Model does not support this protocol".
import test from "node:test";
import assert from "node:assert/strict";
import { opencode_goProvider } from "../../open-sse/config/providers/registry/opencode/go/index.ts";

test("OpenCode Go: gpt-6-luna and grok-4.7 target openai-responses", () => {
  const byId = Object.fromEntries(opencode_goProvider.models.map((m) => [m.id, m]));
  for (const id of ["gpt-6-luna", "grok-4.7"]) {
    assert.equal(byId[id]?.targetFormat, "openai-responses", id);
  }
});
