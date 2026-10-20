// Heuristic symbol detection by regex (v1; no parser). Only top-level declarations, anchored at column 0.
export type Lang = "ts" | "js" | "py" | "rs" | "md" | "json" | "yaml" | "sql" | "sh" | "text"

const EXTENSION_LANG: Readonly<Record<string, Lang>> = {
  ts: "ts",
  tsx: "ts",
  mts: "ts",
  cts: "ts",
  js: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  py: "py",
  rs: "rs",
  md: "md",
  mdx: "md",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  sql: "sql",
  sh: "sh",
}

export const langOf = (path: string): Lang => {
  const base = path.slice(path.lastIndexOf("/") + 1)
  const dot = base.lastIndexOf(".")
  if (dot <= 0) {
    return "text"
  }
  return EXTENSION_LANG[base.slice(dot + 1).toLowerCase()] ?? "text"
}

// Each pattern has exactly one capture group: the symbol name.
const TS_PATTERNS: ReadonlyArray<RegExp> = [
  /^(?:export\s+)?(?:async\s+)?function(?:\s+|\s*\*\s*)(\w+)/,
  /^(?:export\s+)?(?:const|let)\s+(\w+)\s*=/,
  /^(?:export\s+)?class\s+(\w+)/,
]
const PY_PATTERNS: ReadonlyArray<RegExp> = [/^(?:async\s+)?def\s+(\w+)/, /^class\s+(\w+)/]
const RS_PATTERNS: ReadonlyArray<RegExp> = [/^(?:pub(?:\([^)]*\))?\s+)?(?:fn|struct|enum|impl|trait)\s+(\w+)/]

const PATTERNS: Readonly<Partial<Record<Lang, ReadonlyArray<RegExp>>>> = {
  ts: TS_PATTERNS,
  js: TS_PATTERNS,
  py: PY_PATTERNS,
  rs: RS_PATTERNS,
}

// Declarations are short; a longer line is minified or generated and is never matched (keeps regex time linear).
export const MAX_SYMBOL_LINE_CHARS = 1000

export interface SymbolHit {
  readonly line: number // 0-based index into the file's lines
  readonly name: string
}

export const hasSymbolPatterns = (lang: Lang): boolean => PATTERNS[lang] !== undefined

export const findSymbols = (lang: Lang, lines: ReadonlyArray<string>): ReadonlyArray<SymbolHit> => {
  const patterns = PATTERNS[lang]
  if (patterns === undefined) {
    return []
  }
  const hits: Array<SymbolHit> = []
  lines.forEach((text, line) => {
    if (text.length > MAX_SYMBOL_LINE_CHARS) {
      return
    }
    for (const pattern of patterns) {
      const name = pattern.exec(text)?.[1]
      if (name !== undefined) {
        hits.push({ line, name })
        return
      }
    }
  })
  return hits
}
