-- Notion poll memory (T-087). One row per page of a data source: the last_edited_time the poll last diffed.
-- Only the core's Notion poll writes it, in the same transaction as the notion.page_* event it causes.
CREATE TABLE IF NOT EXISTS notion_seen (
  data_source_id text NOT NULL,
  page_id text NOT NULL,
  last_edited_time text NOT NULL /* ISO-8601 UTC, as Notion sent it */,
  PRIMARY KEY (data_source_id, page_id)
);

-- One row per data source that has been baselined. A data source without a row has never been polled: its first poll
-- records its pages and emits no event. watermark is the newest last_edited_time read so far; later polls stop there.
CREATE TABLE IF NOT EXISTS notion_sources (
  data_source_id text PRIMARY KEY,
  watermark text NOT NULL /* ISO-8601 UTC */
);
