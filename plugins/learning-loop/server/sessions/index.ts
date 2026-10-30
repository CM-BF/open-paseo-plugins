// Full-text index of past agent conversations (Hermes session_search over SessionDB FTS5).
// node:sqlite ships with the daemon's Node (24); the trigram tokenizer matches substrings in any
// script, so Chinese phrases work. Terms shorter than three characters fall back to LIKE.

import type { DatabaseSync as DatabaseSyncType, StatementSync } from "node:sqlite";
import type { SearchHit, SessionInfo, SessionMessage } from "../../shared/contracts";

type SqliteModule = typeof import("node:sqlite");

function sqlite(): SqliteModule {
  // getBuiltinModule keeps the bundler away from node:sqlite.
  const mod = process.getBuiltinModule?.("node:sqlite") as SqliteModule | undefined;
  if (!mod) throw new Error("node:sqlite is not available in this Node runtime");
  return mod;
}

export interface SessionMeta {
  agentId: string;
  title: string | null;
  provider: string;
  cwd: string;
  createdAt: string | null;
  updatedAt: string | null;
  archived: boolean;
  scopeKey?: string | null;
}

export interface IndexedMessage {
  seq: number;
  role: SessionMessage["role"];
  at: string | null;
  text: string;
}

export interface SyncState {
  epoch: string | null;
  lastSeq: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  agent_id TEXT PRIMARY KEY,
  title TEXT,
  provider TEXT NOT NULL DEFAULT '',
  cwd TEXT NOT NULL DEFAULT '',
  created_at TEXT,
  updated_at TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  epoch TEXT,
  last_seq INTEGER NOT NULL DEFAULT -1
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  agent_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  at TEXT,
  text TEXT NOT NULL,
  UNIQUE(agent_id, seq)
);
CREATE INDEX IF NOT EXISTS messages_agent ON messages(agent_id, seq);
`;

/** Optional: a daemon whose SQLite lacks FTS5 still searches, through LIKE. */
const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, content='messages', content_rowid='id', tokenize='trigram');
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
`;

/** Splits a query into terms; quoted phrases stay whole. */
export function queryTerms(query: string): string[] {
  const terms: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  for (const match of query.matchAll(re)) {
    const term = (match[1] ?? match[2] ?? "").trim();
    if (term && term.toUpperCase() !== "AND") terms.push(term);
  }
  return terms.slice(0, 12);
}

function ftsPhrase(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function makeSnippet(text: string, terms: readonly string[], width = 160): string {
  const lower = text.toLowerCase();
  let at = -1;
  for (const term of terms) {
    at = lower.indexOf(term.toLowerCase());
    if (at !== -1) break;
  }
  if (at === -1) at = 0;
  const start = Math.max(0, at - Math.floor(width / 3));
  const piece = text.slice(start, start + width).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${piece}${start + width < text.length ? "…" : ""}`;
}

interface SessionRow {
  agent_id: string;
  title: string | null;
  provider: string;
  cwd: string;
  created_at: string | null;
  updated_at: string | null;
  archived: number;
  scope_key?: string | null;
  message_count?: number;
}

export class SessionIndex {
  private readonly db: DatabaseSyncType;
  private readonly stmts: Record<string, StatementSync> = {};
  readonly fts: boolean;

  constructor(path: string, options: { fts?: boolean } = {}) {
    const { DatabaseSync } = sqlite();
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;");
    this.db.exec(SCHEMA);
    const columns = this.db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
    if (!columns.some(c => c.name === "scope_key")) this.db.exec("ALTER TABLE sessions ADD COLUMN scope_key TEXT");
    let fts = options.fts !== false;
    if (fts) {
      try {
        this.db.exec(FTS_SCHEMA);
      } catch (error) {
        console.error(`[learning-loop] SQLite has no FTS5 here; session search falls back to LIKE: ${(error as Error).message}`);
        fts = false;
      }
    }
    this.fts = fts;
  }

  close(): void {
    this.db.close();
  }

  private stmt(sql: string): StatementSync {
    let s = this.stmts[sql];
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts[sql] = s;
    }
    return s;
  }

  syncState(agentId: string): SyncState | null {
    const row = this.stmt("SELECT epoch, last_seq FROM sessions WHERE agent_id = ?").get(agentId) as { epoch: string | null; last_seq: number } | undefined;
    return row ? { epoch: row.epoch, lastSeq: row.last_seq } : null;
  }

  upsertSession(meta: SessionMeta): void {
    this.stmt(
      `INSERT INTO sessions(agent_id, title, provider, cwd, created_at, updated_at, archived)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET
         title = COALESCE(excluded.title, sessions.title), provider = excluded.provider, cwd = excluded.cwd,
         created_at = COALESCE(sessions.created_at, excluded.created_at),
         updated_at = COALESCE(excluded.updated_at, sessions.updated_at), archived = excluded.archived`,
    ).run(meta.agentId, meta.title, meta.provider, meta.cwd, meta.createdAt, meta.updatedAt, meta.archived ? 1 : 0);
    if (meta.scopeKey !== undefined) this.stmt("UPDATE sessions SET scope_key = ? WHERE agent_id = ?").run(meta.scopeKey, meta.agentId);
  }

  markArchived(agentId: string): void {
    this.stmt("UPDATE sessions SET archived = 1 WHERE agent_id = ?").run(agentId);
  }

  /** Replaces messages keyed by seq and moves the sync cursor, in one transaction. */
  applyPage(agentId: string, epoch: string, messages: readonly IndexedMessage[], lastSeq: number, reset: boolean): void {
    this.db.exec("BEGIN");
    try {
      if (reset) this.stmt("DELETE FROM messages WHERE agent_id = ?").run(agentId);
      const upsert = this.stmt(
        `INSERT INTO messages(agent_id, seq, role, at, text) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(agent_id, seq) DO UPDATE SET role = excluded.role, at = excluded.at, text = excluded.text
         WHERE messages.text IS NOT excluded.text`,
      );
      for (const m of messages) upsert.run(agentId, m.seq, m.role, m.at, m.text);
      this.stmt("UPDATE sessions SET epoch = ?, last_seq = ? WHERE agent_id = ?").run(epoch, lastSeq, agentId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private info(row: SessionRow): SessionInfo {
    const count =
      row.message_count ??
      ((this.stmt("SELECT COUNT(*) AS n FROM messages WHERE agent_id = ?").get(row.agent_id) as { n: number }).n);
    return {
      agentId: row.agent_id,
      title: row.title,
      provider: row.provider,
      cwd: row.cwd,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archived: row.archived === 1,
      messageCount: count,
    };
  }

  session(agentId: string): SessionInfo | null {
    const row = this.stmt("SELECT * FROM sessions WHERE agent_id = ?").get(agentId) as SessionRow | undefined;
    return row ? this.info(row) : null;
  }

  stats(): { sessions: number; messages: number } {
    const sessions = (this.stmt("SELECT COUNT(*) AS n FROM sessions WHERE agent_id IN (SELECT DISTINCT agent_id FROM messages)").get() as { n: number }).n;
    const messages = (this.stmt("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n;
    return { sessions, messages };
  }

  recent(limit: number, excludeAgentIds: readonly string[] = [], scopeKey: string | null = null): SessionInfo[] {
    const rows = this.stmt(
      `SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.agent_id = s.agent_id) AS message_count
       FROM sessions s WHERE EXISTS (SELECT 1 FROM messages m WHERE m.agent_id = s.agent_id) AND (? IS NULL OR s.scope_key = ?)
       ORDER BY COALESCE(s.updated_at, s.created_at) DESC LIMIT ?`,
    ).all(scopeKey, scopeKey, limit + excludeAgentIds.length) as unknown as SessionRow[];
    return rows.filter((r) => !excludeAgentIds.includes(r.agent_id)).slice(0, limit).map((r) => this.info(r));
  }

  /**
   * Discovery: the best-matching message per session, sessions ranked by their best match
   * (bm25) and optionally biased by time. Terms are ANDed; a query with no AND hits retries as OR.
   */
  search(
    query: string,
    options: { limit: number; sort?: "relevance" | "newest" | "oldest"; after?: string | null; before?: string | null; excludeAgentIds?: readonly string[]; scopeKey?: string | null },
  ): SearchHit[] {
    const terms = queryTerms(query);
    if (terms.length === 0) return [];
    const run = (mode: "and" | "or") => this.searchWith(terms, mode, options);
    const hits = run("and");
    return hits.length > 0 || terms.length === 1 ? hits : run("or");
  }

  private searchWith(
    terms: readonly string[],
    mode: "and" | "or",
    options: { limit: number; sort?: "relevance" | "newest" | "oldest"; after?: string | null; before?: string | null; excludeAgentIds?: readonly string[]; scopeKey?: string | null },
  ): SearchHit[] {
    const long = this.fts ? terms.filter((t) => [...t].length >= 3) : [];
    const short = this.fts ? terms.filter((t) => [...t].length < 3) : [...terms];
    const where: string[] = [];
    const params: Array<string | number> = [];
    let from = "messages m JOIN sessions s ON s.agent_id = m.agent_id";
    let rank = "0";
    const joiner = mode === "and" ? " AND " : " OR ";
    const textConds: string[] = [];
    if (long.length > 0) {
      if (mode === "and" || short.length === 0) {
        from = "messages_fts f JOIN messages m ON m.id = f.rowid JOIN sessions s ON s.agent_id = m.agent_id";
        textConds.push("messages_fts MATCH ?");
        params.push(long.map(ftsPhrase).join(mode === "and" ? " " : " OR "));
        rank = "bm25(messages_fts)";
      } else {
        for (const t of long) {
          textConds.push("m.text LIKE ? ESCAPE '\\'");
          params.push(likePattern(t));
        }
      }
    }
    for (const t of short) {
      textConds.push("m.text LIKE ? ESCAPE '\\'");
      params.push(likePattern(t));
    }
    where.push(`(${textConds.join(joiner)})`);
    if (options.after) {
      where.push("COALESCE(s.created_at, '') >= ?");
      params.push(options.after);
    }
    if (options.before) {
      where.push("COALESCE(s.created_at, '9999') < ?");
      params.push(options.before);
    }
    if (options.scopeKey) { where.push("s.scope_key = ?"); params.push(options.scopeKey); }
    const exclude = options.excludeAgentIds ?? [];
    if (exclude.length > 0) {
      where.push(`m.agent_id NOT IN (${exclude.map(() => "?").join(",")})`);
      params.push(...exclude);
    }
    const sql = `SELECT m.agent_id, m.seq, m.role, m.at, m.text, ${rank} AS rank FROM ${from} WHERE ${where.join(" AND ")} ORDER BY rank LIMIT 500`;
    const rows = this.db.prepare(sql).all(...params) as Array<{ agent_id: string; seq: number; role: SessionMessage["role"]; at: string | null; text: string; rank: number }>;
    const best = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const seen = best.get(row.agent_id);
      if (!seen || row.rank < seen.rank) best.set(row.agent_id, row);
    }
    let ordered = [...best.values()];
    const sessions = new Map<string, SessionInfo>();
    for (const row of ordered) {
      const info = this.session(row.agent_id);
      if (info) sessions.set(row.agent_id, info);
    }
    ordered = ordered.filter((row) => sessions.has(row.agent_id));
    const stamp = (row: (typeof rows)[number]) => row.at ?? sessions.get(row.agent_id)!.updatedAt ?? "";
    if (options.sort === "newest") ordered.sort((a, b) => stamp(b).localeCompare(stamp(a)) || a.rank - b.rank);
    else if (options.sort === "oldest") ordered.sort((a, b) => stamp(a).localeCompare(stamp(b)) || a.rank - b.rank);
    else ordered.sort((a, b) => a.rank - b.rank);
    return ordered.slice(0, options.limit).map((row) => ({
      session: sessions.get(row.agent_id)!,
      anchor: { seq: row.seq, role: row.role, at: row.at, text: row.text.length > 2000 ? `${row.text.slice(0, 2000)}…` : row.text },
      snippet: makeSnippet(row.text, terms),
    }));
  }

  scopeOf(agentId: string): string | null {
    return (this.stmt("SELECT scope_key FROM sessions WHERE agent_id = ?").get(agentId) as { scope_key?: string } | undefined)?.scope_key ?? null;
  }

  /** Deletes index copies only; keeps cursors so expired history is not fetched again. */
  prune(days: number, now = Date.now()): number {
    if (days <= 0) return 0;
    const cutoff = new Date(now - days * 86_400_000).toISOString();
    const result = this.stmt("DELETE FROM messages WHERE COALESCE(at, (SELECT COALESCE(s.updated_at, s.created_at) FROM sessions s WHERE s.agent_id = messages.agent_id), '0000') < ?").run(cutoff);
    return Number(result.changes);
  }

  clear(): void {
    this.db.exec("BEGIN");
    try { this.db.exec("DELETE FROM messages; DELETE FROM sessions; COMMIT;"); }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  /** Messages around an anchor (scroll), or from the start when anchor is null. */
  window(agentId: string, aroundSeq: number | null, size: number): SessionMessage[] {
    if (aroundSeq === null) {
      return this.stmt("SELECT seq, role, at, text FROM messages WHERE agent_id = ? ORDER BY seq LIMIT ?").all(agentId, size) as unknown as SessionMessage[];
    }
    const half = Math.max(1, Math.floor(size / 2));
    const before = this.stmt("SELECT seq, role, at, text FROM messages WHERE agent_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?").all(agentId, aroundSeq, half) as unknown as SessionMessage[];
    const after = this.stmt("SELECT seq, role, at, text FROM messages WHERE agent_id = ? AND seq >= ? ORDER BY seq LIMIT ?").all(agentId, aroundSeq, size - before.length) as unknown as SessionMessage[];
    return [...before.reverse(), ...after];
  }

  /** First and last messages of a session (Hermes "bookends"). */
  bookends(agentId: string, count = 2): { first: SessionMessage[]; last: SessionMessage[] } {
    const first = this.stmt("SELECT seq, role, at, text FROM messages WHERE agent_id = ? AND role = 'user' ORDER BY seq LIMIT ?").all(agentId, count) as unknown as SessionMessage[];
    const last = (this.stmt("SELECT seq, role, at, text FROM messages WHERE agent_id = ? AND role = 'assistant' ORDER BY seq DESC LIMIT ?").all(agentId, count) as unknown as SessionMessage[]).reverse();
    return { first, last };
  }
}
