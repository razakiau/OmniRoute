/**
 * Homelab (ZAC-263 phase 2): keep main chats and sub-agents on different
 * Claude accounts.
 *
 * The prompt cache belongs to one account, so a chat that moves account writes
 * its whole history again. Main chats (their tools include `ask_user`) stay on
 * the `main` tier; sub-agents, which start a fresh conversation anyway, go to
 * the `subagent` tier. Each falls back to the other tier only when every
 * account of its own is unavailable. Accounts in no tier are the last resort.
 *
 * Config: OMNIROUTE_CLAUDE_ROLE_TIERS='{"main":[ids],"subagent":[ids]}'.
 * Unset, empty or malformed = off: selection is unchanged.
 */

export interface RoleTiers {
  main: string[];
  subagent: string[];
}

export type RequestRole = "main" | "subagent";

const MAIN_CHAT_TOOL = "ask_user";

function idList(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  return value
    .filter((id): id is string => typeof id === "string")
    .map((id) => id.trim())
    .filter(Boolean);
}

export function parseRoleTiers(raw: string | undefined): RoleTiers | null {
  if (!raw || !raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("[ClaudeRoleTiers] OMNIROUTE_CLAUDE_ROLE_TIERS is not valid JSON; tiers off");
    return null;
  }
  const record = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  const main = idList(record.main);
  const subagent = idList(record.subagent);
  if (!main || !subagent) {
    console.warn("[ClaudeRoleTiers] main/subagent must be arrays of ids; tiers off");
    return null;
  }
  if (main.length === 0 && subagent.length === 0) return null;
  return { main, subagent };
}

export function requestRole(body: unknown): RequestRole {
  const tools = (body as { tools?: unknown } | null)?.tools;
  if (!Array.isArray(tools)) return "subagent";
  const isMain = tools.some((tool) => {
    const record = (tool ?? {}) as { name?: unknown; function?: { name?: unknown } };
    return record.function?.name === MAIN_CHAT_TOOL || record.name === MAIN_CHAT_TOOL;
  });
  return isMain ? "main" : "subagent";
}

export function tiersForRequest(
  provider: string,
  body: unknown,
  config: RoleTiers | null = parseRoleTiers(process.env.OMNIROUTE_CLAUDE_ROLE_TIERS)
): string[][] | null {
  if (provider !== "claude" || !config) return null;
  return requestRole(body) === "main"
    ? [config.main, config.subagent]
    : [config.subagent, config.main];
}

export function narrowToFirstTier<T extends { id: string }>(candidates: T[], tiers: string[][]): T[] {
  for (const tier of tiers) {
    const inTier = candidates.filter((candidate) => tier.includes(candidate.id));
    if (inTier.length > 0) return inTier;
  }
  const listed = new Set(tiers.flat());
  return candidates.filter((candidate) => !listed.has(candidate.id));
}
