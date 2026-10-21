-- Drive knowledge sync memory (T-088). One row per Drive file the knowledge sync has read: modified_time is the Drive
-- edit it last saw, sha256 the hash of the text it imported. Only the core's knowledge sync writes it.
CREATE TABLE IF NOT EXISTS drive_files (
  file_id text PRIMARY KEY,
  name text NOT NULL,
  mime text NOT NULL,
  modified_time text NOT NULL /* ISO-8601 UTC, as Drive sent it */,
  sha256 text NOT NULL,
  imported_at text NOT NULL /* ISO-8601 UTC */
);
