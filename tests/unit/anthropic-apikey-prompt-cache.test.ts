/**
 * The Anthropic API-key provider ("anthropic") is Anthropic's own Messages API,
 * so it must get the same heuristic prompt-cache breakpoints as the OAuth
 * provider ("claude"). Without them an OpenAI-format client (no cache_control
 * of its own) is billed the full context uncached on every turn: 0 cache read /
 * 0 cache write across 399 live calls on a homelab, ~150k input each.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { prepareClaudeRequest } from "../../open-sse/translator/helpers/claudeHelper.ts";

type Block = Record<string, unknown>;

function body(): Record<string, unknown> {
  return {
    model: "claude-opus-5-5",
    system: [{ type: "text", text: "You are a coding agent." }],
    messages: [
      { role: "user", content: [{ type: "text", text: "First question" }] },
      { role: "assistant", content: [{ type: "text", text: "First answer" }] },
      { role: "user", content: [{ type: "text", text: "Second question" }] },
    ],
    max_tokens: 128,
  };
}

function markers(b: Record<string, unknown>): Block[] {
  const out: Block[] = [];
  for (const blk of (b.system as Block[]) ?? []) if (blk.cache_control) out.push(blk);
  for (const m of (b.messages as Array<{ content?: Block[] }>) ?? [])
    for (const blk of m.content ?? []) if (blk.cache_control) out.push(blk);
  return out;
}

describe("anthropic (API key) provider prompt caching", () => {
  for (const provider of ["claude", "anthropic"]) {
    test(`${provider}: translated request without client markers gets breakpoints`, () => {
      const r = prepareClaudeRequest(body(), provider, true, "claude-opus-5-5", {
        fallbackToHeuristicWhenNoMarkers: true,
      });
      const system = r.system as Block[];
      assert.ok(system[system.length - 1].cache_control, "last system block is marked");
      assert.ok(markers(r).length >= 2, "system and conversation breakpoints are present");
    });
  }

  test("anthropic: the system breakpoint has the same TTL as claude's", () => {
    const a = prepareClaudeRequest(body(), "anthropic", false, "claude-opus-5-5");
    const c = prepareClaudeRequest(body(), "claude", false, "claude-opus-5-5");
    const last = (x: Record<string, unknown>) => (x.system as Block[]).at(-1)!.cache_control;
    assert.deepEqual(last(a), last(c));
  });
});
