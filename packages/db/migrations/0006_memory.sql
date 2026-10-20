CREATE TABLE IF NOT EXISTS memory_items (id text PRIMARY KEY, scope text NOT NULL, owner_id text NOT NULL,
  kind text NOT NULL, content text NOT NULL, source text NOT NULL, confidence real NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL /* ISO-8601 UTC */, superseded_by text, tombstone INTEGER NOT NULL DEFAULT 0,
  embedding BLOB /* float32[1024], little-endian */);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(content, content='memory_items', content_rowid='rowid');
CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory_items BEGIN INSERT INTO memory_fts(rowid, content) VALUES (new.rowid, new.content); END;
CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory_items BEGIN INSERT INTO memory_fts(memory_fts, rowid, content) VALUES ('delete', old.rowid, old.content); END;
CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE OF content ON memory_items BEGIN INSERT INTO memory_fts(memory_fts, rowid, content) VALUES ('delete', old.rowid, old.content); INSERT INTO memory_fts(rowid, content) VALUES (new.rowid, new.content); END;
CREATE INDEX IF NOT EXISTS memory_items_live ON memory_items (scope, owner_id, kind) WHERE superseded_by IS NULL AND NOT tombstone;
