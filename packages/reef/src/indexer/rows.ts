import { Schema } from "effect"

// Row shape of code_chunks (snake_case, as stored). `symbols` is a JSON array in TEXT, decoded here.
export const SymbolList = Schema.fromJsonString(Schema.Array(Schema.String))

export const CodeChunkRow = Schema.Struct({
  id: Schema.String,
  repo: Schema.String,
  path: Schema.String,
  start_line: Schema.Int,
  end_line: Schema.Int,
  sha256: Schema.String,
  lang: Schema.String,
  symbols: SymbolList,
  content: Schema.String,
  embedding: Schema.NullOr(Schema.instanceOf(Uint8Array)),
  indexed_at: Schema.String,
})
export type CodeChunkRow = typeof CodeChunkRow.Type

// Lightweight projection used to diff a file against the index without loading BLOBs.
export const CodeChunkKey = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  start_line: Schema.Int,
  end_line: Schema.Int,
  sha256: Schema.String,
  has_embedding: Schema.Literals([0, 1]),
})
export type CodeChunkKey = typeof CodeChunkKey.Type
