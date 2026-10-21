import { Effect, Schema } from "effect"
import { NotionError } from "./client.js"

// Shapes of the Notion answers this connector reads. Anything else in an answer is ignored, not an error. Text in
// these answers (titles) is third-party data (R14).
export const TITLE_MAX = 256

const TextPiece = Schema.Struct({ plain_text: Schema.String })
const PropertyWire = Schema.Struct({
  type: Schema.String,
  title: Schema.optionalKey(Schema.Array(TextPiece)),
})

export const PageWire = Schema.Struct({
  object: Schema.Literal("page"),
  id: Schema.String,
  url: Schema.String,
  last_edited_time: Schema.String,
  properties: Schema.Record(Schema.String, PropertyWire),
})
export type PageWire = typeof PageWire.Type

const SearchItemWire = Schema.Struct({
  object: Schema.String,
  id: Schema.String,
  url: Schema.optionalKey(Schema.String),
  last_edited_time: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.Array(TextPiece)),
  properties: Schema.optionalKey(Schema.Record(Schema.String, PropertyWire)),
})
export type SearchItemWire = typeof SearchItemWire.Type

export const SearchWire = Schema.Struct({ results: Schema.Array(SearchItemWire) })
// Results are decoded one by one by the caller: one unreadable entry must not hide the others.
export const ResultsWire = Schema.Struct({ results: Schema.Array(Schema.Unknown) })
export const QueryWire = Schema.Struct({
  results: Schema.Array(Schema.Unknown),
  has_more: Schema.Boolean,
  next_cursor: Schema.NullOr(Schema.String),
})
export const CreatedPageWire = Schema.Struct({ id: Schema.String, url: Schema.String })

// Cuts text into pieces of at most `max` UTF-16 units, never inside a surrogate pair.
export const chunkText = (text: string, max: number): Array<string> => {
  const pieces: Array<string> = []
  let piece = ""
  for (const char of text) {
    if (piece.length + char.length > max) {
      pieces.push(piece)
      piece = ""
    }
    piece += char
  }
  if (piece !== "") pieces.push(piece)
  return pieces
}

export const clip = (text: string, max: number): string => chunkText(text, max)[0] ?? ""

interface TitleSource {
  readonly title?: ReadonlyArray<{ readonly plain_text: string }> | undefined
  readonly properties?:
    | Readonly<
        Record<
          string,
          {
            readonly type: string
            readonly title?: ReadonlyArray<{ readonly plain_text: string }> | undefined
          }
        >
      >
    | undefined
}

// The title of a page or search item: its title property, or the title of a data source. Cut to TITLE_MAX.
export const titleOf = (item: TitleSource): string => {
  const property = Object.values(item.properties ?? {}).find((value) => value.type === "title")
  const pieces = property?.title ?? item.title ?? []
  return clip(pieces.map((piece) => piece.plain_text).join(""), TITLE_MAX)
}

// Decodes an answer of the API at the boundary. The error carries the operation only, never the answer.
export const decodeWire = <A, I>(
  op: string,
  schema: Schema.Codec<A, I>,
  raw: unknown,
): Effect.Effect<A, NotionError> =>
  Schema.decodeUnknownEffect(schema)(raw).pipe(
    Effect.mapError(() => new NotionError({ op, message: `${op} answer does not match its schema` })),
  )
