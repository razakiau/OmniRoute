/**
 * ZAC-263: a new Copilot chat wrote its whole start (tools + system, ~74K) to the
 * prompt cache, because the OAuth path strips tool breakpoints and the system prompt
 * differs at the cwd line and at <session_context>. The helper adds breakpoints on the
 * client's system text just before those two lines, without changing a character.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { placeStablePrefixBreakpoints } from "../../open-sse/services/claudeStablePrefix.ts";

type Block = { type: string; text?: string; cache_control?: unknown; [k: string]: unknown };
type Body = Record<string, unknown> & { system: Block[] };

const CC = { type: "ephemeral", ttl: "1h" };
const BILLING = {
  type: "text",
  text: "x-anthropic-billing-header: cc_version=1; cc_entrypoint=cli; cch=00000;",
};
const SENTINEL = {
  type: "text",
  text: "You are Claude Code, Anthropic's official CLI for Claude.",
};
const HEAD = "You are an AI assistant.\n<environment_context>\nYou are working here.";
const FOLDER = "\n* Current working directory: /x\n* Git repository root: /x\n";
const MID = "<rules>do things</rules>\n\n";
const SESSION = "<session_context>\nSession folder: /s/abc\n</session_context>\n";
const TAIL = "<formatting>be nice</formatting>";
const FULL = HEAD + FOLDER + MID + SESSION + TAIL;

function body(systemText = FULL, extraSystem: Block[] = []): Body {
  return {
    system: [
      { ...BILLING },
      { ...SENTINEL },
      ...extraSystem,
      { type: "text", text: systemText, cache_control: { ...CC } },
    ],
    tools: [
      { name: "bash", input_schema: { type: "object" } },
      { name: "edit", input_schema: { type: "object" } },
    ],
    messages: [
      { role: "user", content: [{ type: "text", text: "hi", cache_control: { ...CC } }] },
      { role: "assistant", content: [{ type: "text", text: "ok", cache_control: { ...CC } }] },
      { role: "user", content: [{ type: "text", text: "go" }] },
    ],
  };
}

function markerCount(b: Body): number {
  let n = 0;
  const count = (x: unknown) => {
    if (x && typeof x === "object" && (x as Block).cache_control !== undefined) n++;
  };
  b.system.forEach(count);
  (b.tools as unknown[]).forEach(count);
  for (const m of b.messages as Array<{ content: unknown }>) {
    if (Array.isArray(m.content)) m.content.forEach(count);
  }
  return n;
}

const ON = {} as NodeJS.ProcessEnv;
const clientText = (b: Body) =>
  b.system
    .slice(2)
    .map((x) => x.text)
    .join("");

test("splits at both markers and keeps the text", () => {
  const b = body();
  const { placed } = placeStablePrefixBreakpoints(b, { env: ON });
  assert.equal(placed, 2);
  assert.equal(b.system.length, 5);
  assert.equal(clientText(b), FULL);
  assert.equal(b.system[2].text, HEAD);
  assert.ok(b.system[3].text!.startsWith("\n* Current working directory:"));
  assert.ok(b.system[4].text!.startsWith("<session_context>"));
});

test("marks the parts before the markers only", () => {
  const b = body();
  placeStablePrefixBreakpoints(b, { env: ON });
  assert.deepEqual(b.system[2].cache_control, CC);
  assert.deepEqual(b.system[3].cache_control, CC);
  assert.equal(b.system[4].cache_control, undefined);
  assert.equal(b.system[0].cache_control, undefined);
  assert.equal(b.system[1].cache_control, undefined);
  for (const t of b.tools as Block[]) assert.equal(t.cache_control, undefined);
});

test("keeps at most 4 markers and never drops its own", () => {
  const b = body();
  // A mid-chat shape: one more message marker than the translator usually sets.
  (b.messages as Array<{ content: Block[] }>)[2].content[0].cache_control = { ...CC };
  placeStablePrefixBreakpoints(b, { env: ON });
  assert.ok(markerCount(b) <= 4, `got ${markerCount(b)}`);
  assert.deepEqual(b.system[2].cache_control, CC);
  assert.deepEqual(b.system[3].cache_control, CC);
  // The latest message marker is the most valuable: it must survive.
  assert.deepEqual((b.messages as Array<{ content: Block[] }>)[2].content[0].cache_control, CC);
});

test("no markers: body untouched (sub-agent prompt)", () => {
  const b = body("You are a subagent. Another agent started you with runSubagent.");
  const before = JSON.stringify(b);
  const { placed } = placeStablePrefixBreakpoints(b, { env: ON });
  assert.equal(placed, 0);
  assert.equal(JSON.stringify(b), before);
});

test("one marker only", () => {
  const text = HEAD + MID + SESSION + TAIL;
  const b = body(text);
  const { placed } = placeStablePrefixBreakpoints(b, { env: ON });
  assert.equal(placed, 1);
  assert.equal(b.system.length, 4);
  assert.equal(clientText(b), text);
  assert.ok(b.system[3].text!.startsWith("<session_context>"));
});

test("never an empty block", () => {
  const text = FOLDER.slice(0) + MID + SESSION + TAIL; // folder marker at offset 0
  const b = body(text);
  const { placed } = placeStablePrefixBreakpoints(b, { env: ON });
  assert.equal(placed, 1);
  assert.equal(clientText(b), text);
  for (const x of b.system) assert.notEqual(x.text, "");
});

test("multiple client blocks: only the one holding the markers is split", () => {
  const first = { type: "text", text: "client preamble" };
  const b = body(FULL, [first]);
  const { placed } = placeStablePrefixBreakpoints(b, { env: ON });
  assert.equal(placed, 2);
  assert.deepEqual(b.system[2], first);
  assert.equal(
    b.system
      .slice(3)
      .map((x) => x.text)
      .join(""),
    FULL
  );
});

test("never marks system[0] or system[1] even if they hold a marker", () => {
  const b = body("no markers here");
  b.system[1] = { type: "text", text: SENTINEL.text + "<session_context>" };
  const { placed } = placeStablePrefixBreakpoints(b, { env: ON });
  assert.equal(placed, 0);
  assert.equal(b.system[1].cache_control, undefined);
});

test("switch off: body untouched", () => {
  for (const v of ["0", "false", "off", "no"]) {
    const b = body();
    const before = JSON.stringify(b);
    const { placed } = placeStablePrefixBreakpoints(b, {
      env: { OMNIROUTE_CLAUDE_STABLE_PREFIX_BREAKPOINTS: v } as NodeJS.ProcessEnv,
    });
    assert.equal(placed, 0, v);
    assert.equal(JSON.stringify(b), before, v);
  }
});

test("custom markers from env", () => {
  const text = "AAA<sess>BBB";
  const b = body(text);
  const { placed } = placeStablePrefixBreakpoints(b, {
    env: { OMNIROUTE_CLAUDE_SESSION_MARKER: "<sess>" } as NodeJS.ProcessEnv,
  });
  assert.equal(placed, 1);
  assert.equal(b.system[2].text, "AAA");
  assert.equal(b.system[3].text, "<sess>BBB");
});
