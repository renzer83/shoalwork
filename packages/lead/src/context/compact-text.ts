// Pure text work of the compaction (T-097): no I/O, no Effect. Every function is linear in the length of its input:
// the text is scanned line by line, and no regex has nested quantifiers. Block items are data (R14): nothing here reads
// an instruction out of them, it only shortens them.

// Chars per token of the default count (estimateTokens: chars / 4), so a summary's room in chars is its room in tokens.
export const CHARS_PER_TOKEN = 4
const ELLIPSIS = " ..."
const FIT_PASSES = 4
// Each fitting pass asks for a little less than the proportion the budget buys, so the text shrinks every pass.
const SHARE_MARGIN = 0.9

// An item that is one head (its first lines) and one fence around the whole body, the shape fenced() writes. A fence in
// the middle of a text, or a text that does not end with its fence, is not split: the item is data as a whole.
export interface FencedItem {
  readonly head: string
  readonly body: string
}

export const splitFenced = (text: string): FencedItem | undefined => {
  const lines = text.split("\n")
  const last = lines.length - 1
  const fence = lines[last]
  if (last < 1 || fence === undefined || !/^`{3,}$/.test(fence)) return undefined
  const open = lines.indexOf(fence)
  if (open === -1 || open === last || lines.indexOf(fence, open + 1) !== last) return undefined
  return { head: lines.slice(0, open).join("\n"), body: lines.slice(open + 1, last).join("\n") }
}

// Line comments (`//`, `/*`, `# `, `-- `). A block comment's middle line is `* ` (or `*` alone) and its end is `*/`:
// a line that starts with `*` and then code (`*ptr = x`) is code.
const COMMENT_PREFIXES: ReadonlyArray<string> = ["//", "/*", "# ", "-- "]
const isBlockCommentLine = (trimmed: string): boolean =>
  trimmed === "*" || trimmed.startsWith("* ") || trimmed.startsWith("*/")
const IMPORT_PREFIXES: ReadonlyArray<string> = ["import ", "using ", "use ", "#include "]
const FROM = /\bfrom\b/
// `import './style.css'`: the whole import is on its line.
const SIDE_EFFECT_IMPORT = /^import\s*["']/
// A multi-line import is dropped up to its `from` line. Past this many lines it was not an import: its lines are kept.
const IMPORT_LINES_MAX = 50

// Level 1 of the compaction: the code without its comments, blank lines and imports. Lossy on purpose, and the only
// level that touches the code itself.
export const stripCode = (body: string): string => {
  const kept: Array<string> = []
  // The lines of a multi-line import that has not reached its `from` yet.
  let pending: Array<string> | undefined
  for (const line of body.split("\n")) {
    const trimmed = line.trim()
    if (pending !== undefined) {
      pending.push(line)
      if (FROM.test(trimmed)) pending = undefined
      else if (pending.length > IMPORT_LINES_MAX) {
        kept.push(...pending)
        pending = undefined
      }
      continue
    }
    if (trimmed === "" || COMMENT_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) continue
    if (isBlockCommentLine(trimmed)) continue
    if (IMPORT_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
      if (trimmed.startsWith("import ") && !FROM.test(trimmed) && !SIDE_EFFECT_IMPORT.test(trimmed))
        pending = [line]
      continue
    }
    if (trimmed.startsWith("from ") && trimmed.includes(" import ")) continue
    kept.push(line)
  }
  if (pending !== undefined) kept.push(...pending)
  return kept.join("\n")
}

// At most `max` characters, cut at a space when there is one, with a visible marker.
const cut = (text: string, max: number): string => {
  if (text.length <= max) return text
  if (max < ELLIPSIS.length) return ""
  const head = text.slice(0, max - ELLIPSIS.length)
  const space = head.lastIndexOf(" ")
  return `${space > 0 ? head.slice(0, space) : head}${ELLIPSIS}`
}

// Shortens `text` until `count` puts it within `maxTokens`, or empties it when it cannot. Each pass keeps the share of
// the text that the budget buys, so a summary that the summarizer made too long is cut to the real token count.
export const fitTokens = (text: string, maxTokens: number, count: (text: string) => number): string => {
  let out = text
  for (let pass = 0; pass < FIT_PASSES && count(out) > maxTokens; pass += 1) {
    out = cut(out, Math.floor(out.length * (maxTokens / count(out)) * SHARE_MARGIN))
  }
  return count(out) > maxTokens ? "" : out
}

// Lines that name a signature or an error: they are kept before the rest of the text.
const SIGNAL =
  /\b(export|function|class|interface|type|def|fn|struct|enum|impl|throw|raise|error|fail|failed|exception|todo|fixme)\b/i

// The deterministic summary (the "light" summarizer of T-097): the first line, then the signature and error lines, then
// the other lines, in their order, as room allows. Gaps are marked. Within `maxTokens` (chars / 4) whatever the input.
export const summarizeText = (text: string, maxTokens: number): string => {
  const max = Math.max(0, Math.floor(maxTokens)) * CHARS_PER_TOKEN
  if (text.length <= max) return text
  const lines = text.split("\n")
  const present: Array<number> = []
  lines.forEach((line, index) => {
    if (line.trim() !== "") present.push(index)
  })
  const [first, ...others] = present
  if (first === undefined) return ""
  const signals = others.filter((index) => SIGNAL.test(lines[index] ?? ""))
  const rest = others.filter((index) => !SIGNAL.test(lines[index] ?? ""))
  const chosen = new Set<number>()
  let size = 0
  for (const index of [first, ...signals, ...rest]) {
    const line = lines[index] ?? ""
    if (size + line.length + 1 <= max) {
      chosen.add(index)
      size += line.length + 1
    } else if (chosen.size === 0) {
      chosen.add(index)
      break
    }
  }
  const out: Array<string> = []
  let previous = -2
  for (const index of [...chosen].sort((a, b) => a - b)) {
    if (out.length > 0 && index !== previous + 1) out.push("...")
    out.push(cut(lines[index] ?? "", max))
    previous = index
  }
  return cut(out.join("\n"), max)
}
