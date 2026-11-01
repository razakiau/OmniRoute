/**
 * Freeze Copilot's <session_context> block per chat until its next compaction (ZAC-272,
 * homelab fork).
 *
 * Copilot's system prompt ends its stable part with a <session_context> block: the chat's
 * session folder plus "N prior checkpoints" and their titles. The harness rewrites that list
 * some calls AFTER a compaction (0 to 597 model calls later, measured Oct 29 - Nov 1), so
 * the prompt cache from that point on is written a second time for nothing. That was 14 of
 * the 21 mid-chat system-prompt changes in main chats over those days.
 *
 * Per chat (the session folder in the block) and prompt kind (the system text's first line,
 * so a subagent never gets its parent's block), the first block seen is replayed until one
 * of these changes, each of which breaks the cache at or before the block anyway:
 *   - the first message of the history (a compaction replaces it with the summary),
 *   - the system text before the block (an AGENTS.md or memory edit),
 *   - the snapshot expires (OMNIROUTE_CLAUDE_FREEZE_SESSION_CONTEXT_TTL_DAYS, default 7),
 *   - an operator clears it (deleteSession; scripts/omniroute-refresh-chat.sh in zhomelab).
 * Only the block is replaced; every other character is the client's own.
 *
 * On: OMNIROUTE_CLAUDE_FREEZE_SESSION_CONTEXT=1|true|yes|on (default off).
 */

import { createHash } from "node:crypto";
import { getDbInstance } from "../../src/lib/db/core.ts";

type Block = Record<string, unknown> & { text?: unknown };

export interface SessionContextSnapshot {
  block: string;
  headHash: string;
  firstHash: string;
  expiresAt: number;
}

export interface SessionContextStore {
  get(session: string, kind: string): SessionContextSnapshot | undefined;
  set(session: string, kind: string, snap: SessionContextSnapshot, now: number): void;
  deleteSession(session: string): number;
}

export type FreezeAction = "off" | "none" | "stored" | "replayed" | "refreshed" | "error";

const OPEN = "<session_context>";
const CLOSE = "</session_context>";
const FOLDER_RE = /Session folder:\s*(\S+)/;
const DAY_MS = 86_400_000;

export function sessionContextFreezeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.OMNIROUTE_CLAUDE_FREEZE_SESSION_CONTEXT;
  return typeof raw === "string" && ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function ttlMs(env: NodeJS.ProcessEnv): number {
  const days = Number(env.OMNIROUTE_CLAUDE_FREEZE_SESSION_CONTEXT_TTL_DAYS);
  return (Number.isFinite(days) && days > 0 ? days : 7) * DAY_MS;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);

function withoutCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheControl);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value))
      if (k !== "cache_control") out[k] = withoutCacheControl(v);
    return out;
  }
  return value;
}

export function freezeSessionContext(
  body: Record<string, unknown>,
  opts: { store: SessionContextStore; env?: NodeJS.ProcessEnv; now?: number }
): { action: FreezeAction; session?: string } {
  const env = opts.env ?? process.env;
  if (!sessionContextFreezeEnabled(env)) return { action: "off" };
  if (!Array.isArray(body?.system)) return { action: "none" };

  const system = body.system as Block[];
  const block = system.find(
    (b) => typeof b?.text === "string" && (b.text as string).includes(OPEN)
  );
  if (!block) return { action: "none" };
  const text = block.text as string;
  const start = text.indexOf(OPEN);
  const closeAt = text.indexOf(CLOSE, start);
  if (closeAt < 0) return { action: "none" };
  const end = closeAt + CLOSE.length;
  const current = text.slice(start, end);
  const folder = FOLDER_RE.exec(current)?.[1];
  if (!folder) return { action: "none" };

  const session = folder.replace(/\/+$/, "").split("/").pop() || folder;
  const head = text.slice(0, start);
  const kind = sha(head.split("\n", 1)[0]);
  const headHash = sha(head);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const firstHash = sha(JSON.stringify(withoutCacheControl(messages[0] ?? null)));
  const now = opts.now ?? Date.now();

  try {
    const stored = opts.store.get(session, kind);
    const fresh: SessionContextSnapshot = {
      block: current,
      headHash,
      firstHash,
      expiresAt: now + ttlMs(env),
    };
    if (!stored || stored.expiresAt <= now) {
      opts.store.set(session, kind, fresh, now);
      return { action: "stored", session };
    }
    if (stored.firstHash !== firstHash || stored.headHash !== headHash) {
      opts.store.set(session, kind, fresh, now);
      return { action: "refreshed", session };
    }
    if (stored.block !== current) block.text = head + stored.block + text.slice(end);
    return { action: "replayed", session };
  } catch (err) {
    console.error(
      `[ZAC-272] session_context freeze skipped: ${err instanceof Error ? err.message : String(err)}`
    );
    return { action: "error", session };
  }
}

export function createMemorySessionContextStore(): SessionContextStore {
  const map = new Map<string, SessionContextSnapshot>();
  const key = (s: string, k: string) => `${s}\x1f${k}`;
  return {
    get: (s, k) => map.get(key(s, k)),
    set: (s, k, snap) => void map.set(key(s, k), snap),
    deleteSession(s) {
      let n = 0;
      for (const k of [...map.keys()]) if (k.startsWith(`${s}\x1f`) && map.delete(k)) n++;
      return n;
    },
  };
}

type Db = {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...p: unknown[]): unknown;
    run(...p: unknown[]): { changes?: number };
  };
};

export function createSqliteSessionContextStore(db: Db): SessionContextStore {
  db.exec(`CREATE TABLE IF NOT EXISTS claude_session_context_snapshots (
    session TEXT NOT NULL,
    kind TEXT NOT NULL,
    block TEXT NOT NULL,
    head_hash TEXT NOT NULL,
    first_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (session, kind)
  )`);
  const get = db.prepare(
    "SELECT block, head_hash, first_hash, expires_at FROM claude_session_context_snapshots WHERE session = ? AND kind = ?"
  );
  const put = db.prepare(
    `INSERT OR REPLACE INTO claude_session_context_snapshots
       (session, kind, block, head_hash, first_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?)`
  );
  const purge = db.prepare("DELETE FROM claude_session_context_snapshots WHERE expires_at <= ?");
  const del = db.prepare("DELETE FROM claude_session_context_snapshots WHERE session = ?");
  return {
    get(s, k) {
      const r = get.get(s, k) as
        { block: string; head_hash: string; first_hash: string; expires_at: number } | undefined;
      return r
        ? {
            block: r.block,
            headHash: r.head_hash,
            firstHash: r.first_hash,
            expiresAt: r.expires_at,
          }
        : undefined;
    },
    set(s, k, snap, now) {
      purge.run(now);
      put.run(s, k, snap.block, snap.headHash, snap.firstHash, snap.expiresAt);
    },
    deleteSession: (s) => Number(del.run(s).changes ?? 0),
  };
}

let defaultStore: SessionContextStore | null = null;

/** The SQLite store on OmniRoute's main database, opened on first use. */
export function getDefaultSessionContextStore(): SessionContextStore {
  if (!defaultStore)
    defaultStore = createSqliteSessionContextStore(getDbInstance() as unknown as Db);
  return defaultStore;
}

/** Executor hook: never throws, never touches the body when the feature is off. */
export function applySessionContextFreeze(body: Record<string, unknown>): FreezeAction {
  if (!sessionContextFreezeEnabled()) return "off";
  try {
    return freezeSessionContext(body, { store: getDefaultSessionContextStore() }).action;
  } catch (err) {
    console.error(
      `[ZAC-272] session_context freeze unavailable: ${err instanceof Error ? err.message : String(err)}`
    );
    return "error";
  }
}
