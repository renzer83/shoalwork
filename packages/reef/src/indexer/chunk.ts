import { createHash } from "node:crypto"
import { markdownSymbols } from "../docs/doc-symbols.js"
import { findSymbols, type Lang } from "./symbols.js"

export const WINDOW_LINES = 60
export const WINDOW_OVERLAP = 10
// A single function longer than this is cut into windows so one chunk never swallows a whole big file.
export const MAX_SYMBOL_CHUNK_LINES = 200
// Hard bounds on text size: embedding models and the FTS index choke on minified or generated lines.
export const MAX_CHUNK_CHARS = 8192
export const MAX_LINE_CHARS = 2000

export interface CodeChunk {
  readonly startLine: number // 1-based, inclusive
  readonly endLine: number // 1-based, inclusive
  readonly content: string
  readonly sha256: string
  readonly symbols: ReadonlyArray<string>
}

export const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex")

// Over-long lines are cut so every line fits inside a chunk on its own.
const splitLines = (content: string): Array<string> => {
  const lines = content.split(/\r?\n/)
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop()
  }
  return lines.map((line) => (line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) : line))
}

const isBlank = (line: string): boolean => line.trim() === ""

// Lines [from, to) as one chunk; trailing blank lines are dropped. Null when nothing but blanks.
const makeChunk = (
  lines: ReadonlyArray<string>,
  from: number,
  to: number,
  symbols: ReadonlyArray<string>,
): CodeChunk | null => {
  let end = to
  while (end > from && isBlank(lines[end - 1] ?? "")) {
    end--
  }
  if (end <= from) {
    return null
  }
  const content = lines.slice(from, end).join("\n")
  return { startLine: from + 1, endLine: end, content, sha256: sha256Hex(content), symbols }
}

const charsOf = (lines: ReadonlyArray<string>, from: number, to: number): number => {
  let total = 0
  for (let index = from; index < to; index++) {
    total += (lines[index]?.length ?? 0) + 1
  }
  return total
}

// Windows of up to WINDOW_LINES lines and MAX_CHUNK_CHARS characters; neighbours share WINDOW_OVERLAP lines when the
// window is long enough. Start lines strictly increase, so (path, start_line) stays unique.
const windows = (
  lines: ReadonlyArray<string>,
  from: number,
  to: number,
  symbols: ReadonlyArray<string>,
  symbolsOf?: (windowFrom: number, windowTo: number) => ReadonlyArray<string>,
): Array<CodeChunk> => {
  const chunks: Array<CodeChunk> = []
  let start = from
  while (start < to) {
    let end = start
    let chars = 0
    while (end < to && end - start < WINDOW_LINES) {
      const next = (lines[end]?.length ?? 0) + 1
      if (end > start && chars + next > MAX_CHUNK_CHARS) {
        break
      }
      chars += next
      end++
    }
    const chunk = makeChunk(lines, start, end, symbolsOf === undefined ? symbols : symbolsOf(start, end))
    if (chunk !== null) {
      chunks.push(chunk)
    }
    if (end >= to) {
      break
    }
    start = end - start > WINDOW_OVERLAP ? end - WINDOW_OVERLAP : end
  }
  return chunks
}

const segment = (
  lines: ReadonlyArray<string>,
  from: number,
  to: number,
  symbols: ReadonlyArray<string>,
): Array<CodeChunk> => {
  if (to - from > MAX_SYMBOL_CHUNK_LINES || charsOf(lines, from, to) > MAX_CHUNK_CHARS) {
    return windows(lines, from, to, symbols)
  }
  const chunk = makeChunk(lines, from, to, symbols)
  return chunk === null ? [] : [chunk]
}

// By declaration when the language has symbol patterns and the file has hits (leading lines form one chunk
// without symbols); otherwise fixed windows.
export const chunkFile = (lang: Lang, content: string): ReadonlyArray<CodeChunk> => {
  const lines = splitLines(content)
  // Markdown has no declarations: its windows carry the headings' words and the backticked identifiers they name.
  if (lang === "md") {
    return windows(lines, 0, lines.length, [], (from, to) => markdownSymbols(lines.slice(from, to)))
  }
  const hits = findSymbols(lang, lines)
  const [first] = hits
  if (first === undefined) {
    return windows(lines, 0, lines.length, [])
  }
  const chunks: Array<CodeChunk> = segment(lines, 0, first.line, [])
  hits.forEach((hit, index) => {
    const next = hits[index + 1]
    chunks.push(...segment(lines, hit.line, next === undefined ? lines.length : next.line, [hit.name]))
  })
  return chunks
}
