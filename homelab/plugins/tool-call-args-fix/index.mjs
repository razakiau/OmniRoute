/**
 * tool-call-args-fix: OmniRoute onRequest plugin (ZAC-94).
 *
 * The bug
 * -------
 * A tool called with no arguments comes back from OmniRoute as an OpenAI
 * tool_call with `arguments: ""`. claude-to-openai.ts starts every tool call at
 * "" and only appends non-empty input_json_delta chunks, so an empty input stays
 * "". When the client replays that turn, openai-to-claude.ts builds
 *
 *   input: tryParseJSON(tc.function.arguments)
 *
 * and tryParseJSON returns the RAW string when JSON.parse fails. "" becomes
 * `tool_use.input: ""` and Anthropic rejects the request:
 *
 *   400 messages.N.content.M.tool_use.input: Input should be an object
 *
 * The call is replayed on every later turn, so one no-argument tool call wedges
 * the whole session. Seen 7 times on 2026-09-24 (keys cde, cde-spike, mac-cli),
 * one of them a Copilot CLI agent that called Linear list_teams with no
 * arguments. Upstream main (6f46050) still has the same line.
 *
 * The fix
 * -------
 * chatCore runs onRequest before translateRequest and replaces the body with
 * the one returned here, so repairing `arguments` in the OpenAI-format body is
 * enough. Absent, null, "", whitespace and "null" mean "no arguments" and
 * become "{}". Anything else is left exactly as the model produced it: turning
 * a truncated or non-object value into {} would silently change what the call
 * meant, so it keeps failing loudly instead.
 *
 * Every provider is covered, not only `claude`: the Claude translator also
 * serves github->claude and other Claude-compatible targets, and "{}" is
 * what an OpenAI-format upstream would have wanted anyway.
 *
 * Returns void when nothing changed, so a clean request is passed through
 * untouched (the hook chain keeps the original body).
 */

const EMPTY = "{}";

/** The `arguments` string to send for one tool call. */
export function normalizeArguments(args) {
  if (args === undefined || args === null) return EMPTY;
  if (typeof args === "object") return JSON.stringify(args);
  if (typeof args !== "string") return args;
  const trimmed = args.trim();
  if (trimmed === "" || trimmed === "null") return EMPTY;
  return args;
}

function fixToolCalls(toolCalls) {
  let fixed = 0;
  const out = toolCalls.map((tc) => {
    if (!tc || typeof tc !== "object" || !tc.function || typeof tc.function !== "object") return tc;
    const args = normalizeArguments(tc.function.arguments);
    if (args === tc.function.arguments) return tc;
    fixed++;
    return { ...tc, function: { ...tc.function, arguments: args } };
  });
  return { out, fixed };
}

export function onRequest(ctx) {
  const body = ctx && ctx.body;
  if (!body || typeof body !== "object" || !Array.isArray(body.messages)) return;

  let total = 0;
  const messages = body.messages.map((m) => {
    if (!m || typeof m !== "object" || m.role !== "assistant" || !Array.isArray(m.tool_calls)) return m;
    const { out, fixed } = fixToolCalls(m.tool_calls);
    if (!fixed) return m;
    total += fixed;
    return { ...m, tool_calls: out };
  });

  if (!total) return;
  return { body: { ...body, messages }, metadata: { toolCallArgsNormalized: total } };
}
