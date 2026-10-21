import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import { looksLikeSecret } from "../indexer/walk.js"
import { lineNames, MAX_TASK_SYMBOLS } from "./doc-symbols.js"

export const DOCS_PER_SYMBOL = 3
export const DOC_EXCERPT_MAX = 300
const HEADING_MAX = 200
const HEADING = /^#{1,6}\s+(.*)$/

export interface DocHit {
  readonly symbol: string
  readonly path: string
  readonly heading: string // the heading the excerpt sits under, "" when the chunk has none
  readonly excerpt: string // at most DOC_EXCERPT_MAX characters, from the line that names the symbol
}

const DocRow = Schema.Struct({
  path: Schema.String,
  start_line: Schema.Int,
  content: Schema.String,
})
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(DocRow))

type DocRowT = typeof DocRow.Type

const headingText = (line: string | undefined): string | undefined => {
  const match = line === undefined ? null : HEADING.exec(line)
  return match?.[1]?.trim().slice(0, HEADING_MAX)
}

// The heading above the symbol in the chunk, else the first heading of the chunk, else "".
const headingFor = (lines: ReadonlyArray<string>, at: number): string => {
  for (let index = at; index >= 0; index--) {
    const heading = headingText(lines[index])
    if (heading !== undefined) return heading
  }
  return lines.map(headingText).find((heading) => heading !== undefined) ?? ""
}

// One hit from a markdown chunk, or undefined when the chunk does not name the symbol on a line of its own or the
// excerpt looks like a secret (docs are data too: the walker's screen applies here as well).
const hitFrom = (symbol: string, row: DocRowT): DocHit | undefined => {
  const lines = row.content.split("\n")
  const at = lines.findIndex((line) => lineNames(line, symbol))
  if (at < 0) return undefined
  const excerpt = lines.slice(at).join("\n").slice(0, DOC_EXCERPT_MAX)
  if (looksLikeSecret(excerpt)) return undefined
  return { symbol, path: row.path, heading: headingFor(lines, at), excerpt }
}

// Up to DOCS_PER_SYMBOL markdown excerpts per symbol, in the order the symbols were asked for. Only `.md` chunks whose
// symbols include the name are considered.
export const docsForSymbols = (
  repo: string,
  symbols: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<DocHit>, SqlError | Schema.SchemaError, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const hits: Array<DocHit> = []
    const asked = [...new Set(symbols)].slice(0, MAX_TASK_SYMBOLS)
    for (const symbol of asked) {
      const rows = yield* decodeRows(
        yield* sql`SELECT path, start_line, content FROM code_chunks
          WHERE repo = ${repo} AND lang = 'md'
            AND EXISTS (SELECT 1 FROM json_each(code_chunks.symbols) AS s WHERE s.value = ${symbol})
          ORDER BY path, start_line
          LIMIT ${DOCS_PER_SYMBOL}`,
      )
      for (const row of rows) {
        const hit = hitFrom(symbol, row)
        if (hit !== undefined) hits.push(hit)
      }
    }
    return hits
  })
