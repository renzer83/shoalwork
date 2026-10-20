CREATE TABLE IF NOT EXISTS code_chunks (id text PRIMARY KEY, repo text NOT NULL, path text NOT NULL, start_line int NOT NULL, end_line int NOT NULL,
  sha256 text NOT NULL, lang text NOT NULL, symbols TEXT NOT NULL DEFAULT '[]' /* JSON array */, content text NOT NULL,
  embedding BLOB /* float32[1024], little-endian */, indexed_at TEXT NOT NULL /* ISO-8601 UTC */);
CREATE UNIQUE INDEX IF NOT EXISTS code_chunks_key ON code_chunks (repo, path, start_line);
CREATE VIRTUAL TABLE IF NOT EXISTS code_fts USING fts5(content, path, symbols, content='code_chunks', content_rowid='rowid');
CREATE TRIGGER IF NOT EXISTS code_chunks_ai AFTER INSERT ON code_chunks BEGIN INSERT INTO code_fts(rowid, content, path, symbols) VALUES (new.rowid, new.content, new.path, new.symbols); END;
CREATE TRIGGER IF NOT EXISTS code_chunks_ad AFTER DELETE ON code_chunks BEGIN INSERT INTO code_fts(code_fts, rowid, content, path, symbols) VALUES ('delete', old.rowid, old.content, old.path, old.symbols); END;
CREATE TRIGGER IF NOT EXISTS code_chunks_au AFTER UPDATE OF content, path, symbols ON code_chunks BEGIN INSERT INTO code_fts(code_fts, rowid, content, path, symbols) VALUES ('delete', old.rowid, old.content, old.path, old.symbols); INSERT INTO code_fts(rowid, content, path, symbols) VALUES (new.rowid, new.content, new.path, new.symbols); END;
