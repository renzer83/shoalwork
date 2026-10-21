-- Calibration of the approximate tokenizer per executor and language (T-095): one row per (executor, lang), factor in
-- chars per token. Written after each usage.recorded; read at boot to restore the factors. Nothing else writes it.
CREATE TABLE IF NOT EXISTS tokenizer_calibration (
  executor text NOT NULL,
  lang text NOT NULL CHECK (lang IN ('code', 'prose_pt', 'prose_en')),
  factor real NOT NULL,
  n integer NOT NULL,
  updated_at text NOT NULL /* ISO-8601 UTC */,
  PRIMARY KEY (executor, lang)
);
