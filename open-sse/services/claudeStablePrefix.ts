/**
 * Stable-prefix breakpoints for the native Claude OAuth path (ZAC-263, homelab fork).
 *
 * The OAuth path deletes cache_control from every tool (the real CLI never marks
 * tools), so a request's first breakpoint is the end of the system prompt. Copilot's
 * system prompt is one block that differs between chats at the cwd line and at the
 * <session_context> line (the session id), so a new chat matched nothing and wrote
 * tools + system again (~74K). Measured 2026-10-31: same-folder chats are
 * byte-identical up to <session_context>.
 *
 * This splits the client's system block just before each marker and marks the part
 * before it, so a new chat reads the shared start back: ~34K anywhere, ~72K in a
 * folder used within the hour. The text is unchanged: the parts concatenate to the
 * original block. Never marks a tool, system[0] (billing line) or system[1] (the
 * Claude Code sentinel), and keeps the request at <= 4 breakpoints.
 *
 * Off: OMNIROUTE_CLAUDE_STABLE_PREFIX_BREAKPOINTS=0|false|no|off.
 */

type Block = Record<string, unknown> & { text?: unknown; cache_control?: unknown };

const MAX_BREAKPOINTS = 4;
const FIRST_CLIENT_BLOCK = 2;
const DEFAULT_FOLDER_MARKER = "\n* Current working directory:";
const DEFAULT_SESSION_MARKER = "<session_context>";

export function stablePrefixBreakpointsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.OMNIROUTE_CLAUDE_STABLE_PREFIX_BREAKPOINTS;
  if (typeof raw !== "string") return true;
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

function marker(raw: string | undefined, fallback: string): string {
  return typeof raw === "string" && raw.length > 0 ? raw : fallback;
}

export function placeStablePrefixBreakpoints(
  body: Record<string, unknown>,
  opts: { env?: NodeJS.ProcessEnv } = {}
): { placed: number } {
  const env = opts.env ?? process.env;
  if (!stablePrefixBreakpointsEnabled(env) || !Array.isArray(body?.system)) return { placed: 0 };
  const system = body.system as Block[];
  const markers = [
    marker(env.OMNIROUTE_CLAUDE_FOLDER_MARKER, DEFAULT_FOLDER_MARKER),
    marker(env.OMNIROUTE_CLAUDE_SESSION_MARKER, DEFAULT_SESSION_MARKER),
  ];

  const own = new Set<Block>();
  for (const m of markers) {
    for (let i = FIRST_CLIENT_BLOCK; i < system.length; i++) {
      const block = system[i];
      if (typeof block?.text !== "string") continue;
      const at = block.text.indexOf(m);
      if (at <= 0) continue;
      const { cache_control: _dropped, ...rest } = block;
      const before: Block = {
        ...rest,
        text: block.text.slice(0, at),
        cache_control: { type: "ephemeral", ttl: "1h" },
      };
      const after: Block = { ...block, text: block.text.slice(at) };
      system.splice(i, 1, before, after);
      own.add(before);
      break;
    }
  }
  if (own.size === 0) return { placed: 0 };

  // The system-end breakpoint the translator set is covered by ours and the message ones.
  const last = system[system.length - 1];
  if (last && !own.has(last)) delete last.cache_control;

  trimToLimit(body, own);
  return { placed: own.size };
}

function trimToLimit(body: Record<string, unknown>, own: Set<Block>): void {
  const others: Block[] = [];
  const messageMarks: Block[] = [];
  const isMarked = (b: unknown): b is Block =>
    !!b && typeof b === "object" && (b as Block).cache_control !== undefined;
  for (const b of body.system as Block[]) if (isMarked(b) && !own.has(b)) others.push(b);
  if (Array.isArray(body.tools)) for (const t of body.tools) if (isMarked(t)) others.push(t);
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages as Array<{ content?: unknown }>) {
      if (Array.isArray(msg?.content))
        for (const c of msg.content) if (isMarked(c)) messageMarks.push(c);
    }
  }
  let excess = own.size + others.length + messageMarks.length - MAX_BREAKPOINTS;
  // Earliest first: later breakpoints cover more of the prefix.
  for (const list of [messageMarks, others]) {
    for (const b of list) {
      if (excess <= 0) return;
      delete b.cache_control;
      excess--;
    }
  }
}
