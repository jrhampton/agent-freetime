import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS personalities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  system_prompt TEXT NOT NULL DEFAULT '',
  personality_id INTEGER REFERENCES personalities(id) ON DELETE SET NULL,
  provider TEXT NOT NULL DEFAULT 'freellmapi',
  model TEXT NOT NULL DEFAULT '',
  shared_memory INTEGER NOT NULL DEFAULT 1,
  web_enabled INTEGER NOT NULL DEFAULT 1,
  allow_domains TEXT NOT NULL DEFAULT '',
  block_domains TEXT NOT NULL DEFAULT '',
  max_steps INTEGER NOT NULL DEFAULT 8,
  min_rest_minutes REAL NOT NULL DEFAULT 2,
  max_rest_minutes REAL NOT NULL DEFAULT 60,
  session_minutes REAL NOT NULL DEFAULT 0,
  daily_token_budget INTEGER NOT NULL DEFAULT 200000,
  color TEXT NOT NULL DEFAULT '#7c5cff',
  autostart INTEGER NOT NULL DEFAULT 0,
  last_chat_seen_id INTEGER NOT NULL DEFAULT 0,
  tick_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- profile_id NULL + scope 'shared' = the shared pool; author_id records who wrote it.
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER REFERENCES profiles(id) ON DELETE CASCADE,
  author_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
  scope TEXT NOT NULL CHECK (scope IN ('private','shared')),
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  importance REAL NOT NULL DEFAULT 5,
  pinned INTEGER NOT NULL DEFAULT 0,
  embedding BLOB,
  access_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TEXT,
  tick_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS memories_profile ON memories(profile_id, created_at);
CREATE INDEX IF NOT EXISTS memories_scope ON memories(scope, created_at);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, content='memories', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TABLE IF NOT EXISTS ticks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  steps INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  model_used TEXT,
  summary TEXT,
  rest_minutes REAL,
  error TEXT
);
CREATE INDEX IF NOT EXISTS ticks_profile ON ticks(profile_id, id);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER REFERENCES profiles(id) ON DELETE CASCADE,
  tick_id INTEGER,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS events_profile ON events(profile_id, id);

CREATE TABLE IF NOT EXISTS web_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER REFERENCES profiles(id) ON DELETE CASCADE,
  tick_id INTEGER,
  tool TEXT NOT NULL,
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  domain TEXT NOT NULL,
  status INTEGER,
  bytes INTEGER,
  duration_ms INTEGER,
  blocked INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS web_profile ON web_requests(profile_id, id);
CREATE INDEX IF NOT EXISTS web_domain ON web_requests(domain);

CREATE TABLE IF NOT EXISTS dm_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  sender TEXT NOT NULL CHECK (sender IN ('user','agent')),
  content TEXT NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS dm_profile ON dm_messages(profile_id, id);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room TEXT NOT NULL DEFAULT 'lobby',
  sender_type TEXT NOT NULL CHECK (sender_type IN ('agent','user','system')),
  profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
  sender_name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS chat_room ON chat_messages(room, id);
`;

export function openDb(file?: string): DB {
  const target = file ?? path.join(config.dataDir, "harness.db");
  if (target !== ":memory:") fs.mkdirSync(path.dirname(target), { recursive: true });
  const db = new Database(target);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Columns added after the first release; CREATE TABLE IF NOT EXISTS won't add them to old databases. */
function migrate(db: DB) {
  const add = (table: string, column: string, def: string) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  };
  add("profiles", "session_minutes", "REAL NOT NULL DEFAULT 0");
}

/** SQLite datetime('now') strings are UTC without a zone marker. */
export function parseDbTime(s: string | null | undefined): number {
  if (!s) return 0;
  return Date.parse(s.includes("T") ? s : s.replace(" ", "T") + "Z");
}
