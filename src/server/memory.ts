import type { DB } from "./db.js";
import { parseDbTime } from "./db.js";
import { embed } from "./llm.js";
import type { AppSettings } from "./settings.js";
import { bus } from "./bus.js";

export type MemoryKind = "episode" | "fact" | "journal" | "reflection" | "relationship" | "note";

export interface MemoryRow {
  id: number;
  profile_id: number | null;
  author_id: number | null;
  scope: "private" | "shared";
  kind: MemoryKind;
  content: string;
  importance: number;
  pinned: number;
  embedding: Buffer | null;
  access_count: number;
  last_accessed_at: string | null;
  tick_id: number | null;
  created_at: string;
}

export interface NewMemory {
  profileId: number | null;
  authorId: number | null;
  scope: "private" | "shared";
  kind: MemoryKind;
  content: string;
  importance?: number;
  tickId?: number | null;
  pinned?: boolean;
}

function toBlob(v: number[]): Buffer {
  return Buffer.from(new Float32Array(v).buffer);
}

function fromBlob(b: Buffer): Float32Array {
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return 0;
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export async function addMemory(db: DB, settings: AppSettings, m: NewMemory): Promise<MemoryRow> {
  const importance = Math.max(1, Math.min(10, m.importance ?? 5));
  const vec = (await embed(settings, [m.content]))?.[0];
  const info = db
    .prepare(
      `INSERT INTO memories (profile_id, author_id, scope, kind, content, importance, pinned, embedding, tick_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      m.scope === "shared" ? null : m.profileId,
      m.authorId,
      m.scope,
      m.kind,
      m.content,
      importance,
      m.pinned ? 1 : 0,
      vec ? toBlob(vec) : null,
      m.tickId ?? null,
    );
  const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(info.lastInsertRowid) as MemoryRow;
  bus.publish({ channel: "memory", profileId: m.profileId, payload: stripEmbedding(row) });
  return row;
}

export function stripEmbedding(r: MemoryRow) {
  const { embedding, ...rest } = r;
  return { ...rest, has_embedding: !!embedding };
}

function ftsQuery(q: string): string | null {
  const words = q
    .toLowerCase()
    .match(/[\p{L}\p{N}]{3,}/gu)
    ?.slice(0, 24);
  if (!words?.length) return null;
  return [...new Set(words)].map((w) => `"${w}"`).join(" OR ");
}

export interface RecallOptions {
  profileId: number;
  includeShared: boolean;
  query: string;
  limit?: number;
  excludeIds?: Set<number>;
  /** Count these as accessed (refreshes their recency). */
  touch?: boolean;
}

export interface ScoredMemory extends MemoryRow {
  score: number;
}

/**
 * Generative-agents style retrieval: relevance + recency + importance.
 * Relevance comes from embeddings when available, otherwise from FTS5 BM25.
 */
export async function recall(db: DB, settings: AppSettings, o: RecallOptions): Promise<ScoredMemory[]> {
  const limit = o.limit ?? 12;
  const scopeClause = o.includeShared ? "(profile_id = @pid OR scope = 'shared')" : "profile_id = @pid";
  const candidates = db
    .prepare(`SELECT * FROM memories WHERE ${scopeClause} ORDER BY id DESC LIMIT 5000`)
    .all({ pid: o.profileId }) as MemoryRow[];
  if (!candidates.length) return [];

  const relevance = new Map<number, number>();
  const qvec = o.query.trim() ? (await embed(settings, [o.query]))?.[0] : undefined;
  if (qvec) {
    for (const c of candidates) if (c.embedding) relevance.set(c.id, Math.max(0, cosine(qvec, fromBlob(c.embedding))));
  }
  // FTS also covers memories saved while embeddings were unavailable.
  const fq = ftsQuery(o.query);
  if (fq) {
    const hits = db
      .prepare(`SELECT rowid AS id, bm25(memories_fts) AS rank FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rank LIMIT 200`)
      .all(fq) as { id: number; rank: number }[];
    if (hits.length) {
      const best = Math.min(...hits.map((h) => h.rank));
      for (const h of hits) {
        const r = best < 0 ? h.rank / best : 0.5; // bm25 is negative; closer to best = more relevant
        relevance.set(h.id, Math.max(relevance.get(h.id) ?? 0, 0.8 * r));
      }
    }
  }

  const now = Date.now();
  const scored: ScoredMemory[] = candidates
    .filter((c) => !o.excludeIds?.has(c.id))
    .map((c) => {
      const t = parseDbTime(c.last_accessed_at) || parseDbTime(c.created_at);
      const hours = Math.max(0, (now - t) / 3_600_000);
      const recency = Math.pow(0.995, hours);
      const rel = relevance.get(c.id) ?? 0;
      const score = 1.0 * rel + 0.6 * recency + 0.5 * (c.importance / 10) + (c.pinned ? 0.5 : 0);
      return { ...c, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  if (o.touch && scored.length) {
    const stmt = db.prepare("UPDATE memories SET access_count = access_count + 1, last_accessed_at = datetime('now') WHERE id = ?");
    db.transaction(() => scored.forEach((s) => stmt.run(s.id)))();
  }
  return scored;
}

export function pinnedMemories(db: DB, profileId: number, includeShared: boolean): MemoryRow[] {
  const scopeClause = includeShared ? "(profile_id = ? OR scope = 'shared')" : "profile_id = ?";
  return db.prepare(`SELECT * FROM memories WHERE ${scopeClause} AND pinned = 1 ORDER BY id`).all(profileId) as MemoryRow[];
}

export function recentEpisodes(db: DB, profileId: number, n: number): MemoryRow[] {
  return (
    db
      .prepare("SELECT * FROM memories WHERE profile_id = ? AND kind = 'episode' ORDER BY id DESC LIMIT ?")
      .all(profileId, n) as MemoryRow[]
  ).reverse();
}

export function formatMemory(m: MemoryRow, nameOf: (id: number | null) => string, selfId: number): string {
  const when = m.created_at.slice(0, 16).replace("T", " ");
  const who = m.scope === "shared" ? ` shared by ${m.author_id === selfId ? "you" : nameOf(m.author_id)}` : "";
  return `[#${m.id} ${m.kind}${who}, ${when} UTC, importance ${m.importance}] ${m.content}`;
}
