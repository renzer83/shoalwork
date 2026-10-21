import { Effect, Schema } from "effect"
import { parse } from "yaml"

// Pure parsing of a repo's rules file: its sections, its frontmatter globs, and the glob matcher. Every loop here is
// linear in the input; no regex runs over a whole line, so a hostile file cannot make it slow.
export const FRONTMATTER_MAX = 4096
export const PATH_MAX = 200
export const HEADING_STORE_MAX = 200
const GLOB_MAX = 100
const GLOBS_PER_FILE_MAX = 20
const MIN_WORD = 3
const OPEN_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const CLOSE_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/
// A line that cannot be the text of a setext heading: blank, indented code, quote or list item.
const NOT_PARAGRAPH = /^(?:\s*$| {4}|\t|\s*>|\s*[-*+][ \t]|\s*\d+[.)][ \t])/

// Function words that say nothing about a rule (English and Portuguese). They never score.
const STOPWORDS: ReadonlySet<string> = new Set([
  "about",
  "after",
  "all",
  "also",
  "and",
  "any",
  "are",
  "before",
  "beside",
  "but",
  "can",
  "com",
  "con",
  "das",
  "dos",
  "each",
  "every",
  "for",
  "from",
  "has",
  "have",
  "into",
  "its",
  "not",
  "não",
  "nas",
  "nos",
  "one",
  "only",
  "our",
  "over",
  "para",
  "por",
  "que",
  "sem",
  "should",
  "than",
  "that",
  "the",
  "then",
  "this",
  "through",
  "under",
  "uma",
  "use",
  "was",
  "what",
  "when",
  "where",
  "which",
  "will",
  "with",
  "you",
  "your",
])

// Lowercase words of three letters or more, lightly stemmed, so that "tests", "testing" and "test" are one term.
export const terms = (text: string): ReadonlyArray<string> =>
  (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((word) => word.length >= MIN_WORD && !STOPWORDS.has(word))
    .map((word) => {
      const cut = word.replace(/(?:ing|ed|s)$/u, "")
      return cut.length >= MIN_WORD ? cut : word
    })

export interface Piece {
  readonly heading: string
  readonly body: string
}

// ATX heading (`# Title`, up to three spaces of indent, one to three hashes): its level and text, or undefined.
const atxHeading = (line: string): { readonly text: string } | undefined => {
  let start = 0
  while (start < 3 && line[start] === " ") start += 1
  let end = start
  while (line[end] === "#") end += 1
  const level = end - start
  if (level < 1 || level > 3 || (end < line.length && line[end] !== " " && line[end] !== "\t"))
    return undefined
  const text = line.slice(end).trim()
  let cut = text.length
  while (cut > 0 && text[cut - 1] === "#") cut -= 1
  const closed = cut < text.length && (cut === 0 || text[cut - 1] === " " || text[cut - 1] === "\t")
  return { text: closed ? text.slice(0, cut).trim() : text }
}

// Markdown split at its headings (levels 1 to 3), the way CommonMark reads them: ATX and setext (`Title` over `===`).
// A line inside a fenced code block never starts a section, and a fence opens only where CommonMark opens one and
// closes only with a fence of the same character and at least the same length. Text before the first heading belongs
// to no section.
export const splitSections = (markdown: string): ReadonlyArray<Piece> => {
  const sections: Array<{ heading: string; lines: Array<string> }> = []
  let fence: { readonly char: string; readonly length: number } | undefined
  let previous: string | undefined
  for (const line of markdown.split(/\r?\n/)) {
    const current = sections.at(-1)
    if (fence !== undefined) {
      const close = CLOSE_FENCE.exec(line)?.[1]
      if (close !== undefined && close[0] === fence.char && close.length >= fence.length) fence = undefined
      current?.lines.push(line)
      continue
    }
    const open = OPEN_FENCE.exec(line)
    if (open !== null && !((open[1] ?? "").startsWith("`") && (open[2] ?? "").includes("`"))) {
      fence = { char: (open[1] ?? "`")[0] ?? "`", length: (open[1] ?? "").length }
      current?.lines.push(line)
      previous = undefined
      continue
    }
    const atx = atxHeading(line)
    if (atx !== undefined) {
      sections.push({ heading: atx.text.slice(0, HEADING_STORE_MAX), lines: [] })
      previous = undefined
      continue
    }
    if (previous !== undefined && SETEXT_UNDERLINE.test(line)) {
      if (current?.lines.at(-1) === previous) current.lines.pop()
      sections.push({ heading: previous.trim().slice(0, HEADING_STORE_MAX), lines: [] })
      previous = undefined
      continue
    }
    current?.lines.push(line)
    previous = NOT_PARAGRAPH.test(line) ? undefined : line
  }
  return sections.map(({ heading, lines }) => ({ heading, body: lines.join("\n").trim() }))
}

// The frontmatter (between two `---` lines at the top of the file, within FRONTMATTER_MAX chars) and the rest of it.
export const splitFrontmatter = (
  text: string,
): { readonly front: string; readonly body: string } | undefined => {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return undefined
  const end = text.slice(0, FRONTMATTER_MAX + 8).indexOf("\n---", 3)
  if (end < 0) return undefined
  const after = text.slice(end + 4)
  if (after !== "" && !after.startsWith("\n") && !after.startsWith("\r\n")) return undefined
  return { front: text.slice(0, end).replace(/^---\r?\n/, ""), body: after.replace(/^\r?\n/, "") }
}

const Patterns = Schema.Union([Schema.String, Schema.Array(Schema.String)])
const FrontMatter = Schema.Struct({
  paths: Schema.optionalKey(Patterns),
  globs: Schema.optionalKey(Patterns),
})

// A list, or a comma-separated string (`.mdc`), trimmed and capped in count and length.
const globsOf = (value: string | ReadonlyArray<string> | undefined): ReadonlyArray<string> => {
  const list = typeof value === "string" ? value.split(",") : (value ?? [])
  return list
    .map((glob) => glob.trim())
    .filter((glob) => glob !== "" && glob.length <= GLOB_MAX)
    .slice(0, GLOBS_PER_FILE_MAX)
}

// The globs of a frontmatter: `paths` (Claude Code) and `globs` (Cursor). Frontmatter that does not decode is reported
// and gives no globs: its sections stay, as unscoped rules.
export const frontmatterGlobs = (rel: string, front: string): Effect.Effect<ReadonlyArray<string>> =>
  Effect.try({ try: (): unknown => parse(front), catch: (cause) => cause }).pipe(
    Effect.flatMap((raw) => Schema.decodeUnknownEffect(FrontMatter)(raw)),
    Effect.map((meta) => [...globsOf(meta.paths), ...globsOf(meta.globs)]),
    Effect.catch((cause) =>
      Effect.logWarning(`rules: frontmatter of ${rel} is not valid, its globs are ignored`).pipe(
        Effect.annotateLogs({ cause: String(cause) }),
        Effect.as([]),
      ),
    ),
  )

// A glob over a repo path: `*` (not across a slash), `**` (across them; `**/` may match no directory), `?`. Dynamic
// programming over both strings, so the work is bounded by the caps on both lengths.
export const globMatch = (pattern: string, path: string): boolean => {
  if (path.length > PATH_MAX) return false
  const p = pattern.length
  const t = path.length
  const width = t + 1
  // reach[i * width + j]: pattern from i matches path from j. Filled from the end, so every read is already set.
  const reach = new Uint8Array((p + 1) * width)
  const at = (i: number, j: number): number => reach[i * width + j] ?? 0
  reach[p * width + t] = 1
  for (let i = p - 1; i >= 0; i -= 1) {
    for (let j = t; j >= 0; j -= 1) {
      const c = pattern[i]
      const next = i + 1
      let ok: boolean
      if (c === "*" && pattern[next] === "*") {
        const rest = pattern[i + 2] === "/" ? i + 3 : i + 2
        ok = at(rest, j) === 1 || (j < t && at(i, j + 1) === 1)
      } else if (c === "*") {
        ok = at(next, j) === 1 || (j < t && path[j] !== "/" && at(i, j + 1) === 1)
      } else if (c === "?") {
        ok = j < t && path[j] !== "/" && at(next, j + 1) === 1
      } else {
        ok = j < t && path[j] === c && at(next, j + 1) === 1
      }
      reach[i * width + j] = ok ? 1 : 0
    }
  }
  return at(0, 0) === 1
}
