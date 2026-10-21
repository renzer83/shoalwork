import { findSymbols, langOf } from "../indexer/symbols.js"

// Symbols a markdown chunk can be found by. Capped so that a huge page cannot bloat its row.
export const MAX_DOC_SYMBOLS = 64
export const MAX_TASK_SYMBOLS = 20

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/
// A backtick span of at most 80 characters on one line: bounded, so the scan is linear on hostile input.
const BACKTICK_SPAN = /`([^`\n]{1,80})`/g
const HEADING = /^#{1,6}\s+(.*)$/
const HEADING_WORD = /[A-Za-z_][A-Za-z0-9_]{2,}/g
const NON_IDENTIFIER = /[^A-Za-z0-9_$]+/

// The identifiers a backtick span names: `name`, `name()`, `Foo.bar` (both segments). Anything else is no symbol.
export const identifiersIn = (span: string): Array<string> =>
  span
    .replace(/\(\)$/, "")
    .split(".")
    .filter((part) => IDENTIFIER.test(part))

// Symbols of a window of markdown lines: the identifiers in its backticks and the words of its headings.
export const markdownSymbols = (lines: ReadonlyArray<string>): Array<string> => {
  const found = new Set<string>()
  for (const line of lines) {
    const heading = HEADING.exec(line)?.[1]
    if (heading !== undefined) {
      for (const word of heading.match(HEADING_WORD) ?? []) found.add(word)
    }
    for (const span of line.matchAll(BACKTICK_SPAN)) {
      for (const identifier of identifiersIn(span[1] ?? "")) found.add(identifier)
    }
    if (found.size >= MAX_DOC_SYMBOLS) break
  }
  return [...found].slice(0, MAX_DOC_SYMBOLS)
}

// The symbols a task names: the identifiers in backticks of its text, and the exported declarations of the files it
// is about (read by the caller). Unique, in the order found, at most MAX_TASK_SYMBOLS.
export const taskSymbols = (
  text: string,
  files: ReadonlyArray<{ readonly path: string; readonly content: string }>,
): Array<string> => {
  const found = new Set<string>()
  for (const line of text.split("\n")) {
    for (const span of line.matchAll(BACKTICK_SPAN)) {
      for (const identifier of identifiersIn(span[1] ?? "")) found.add(identifier)
    }
  }
  for (const file of files) {
    const lines = file.content.split("\n")
    for (const hit of findSymbols(langOf(file.path), lines)) {
      if (lines[hit.line]?.startsWith("export")) found.add(hit.name)
    }
  }
  return [...found].slice(0, MAX_TASK_SYMBOLS)
}

// Whether a line names the symbol as a whole identifier (not as part of a longer one).
export const lineNames = (line: string, symbol: string): boolean =>
  line.split(NON_IDENTIFIER).includes(symbol)
