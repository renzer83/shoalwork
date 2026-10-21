import { posix } from "node:path"
import { normalizePath } from "./signals.js"

// Text of a repo or a prompt is untrusted and can be hostile: every pattern below is applied to one bounded line at a
// time, has no nested quantifier, and the work done is counted so a test can prove it grows linearly with the input.
export const MAX_LINE_CHARS = 1000
export const MAX_SPECIFIERS = 200
// Regexes run per line that mentions import syntax; the bound on characters handed to them is this times the input size.
export const PATTERNS_PER_LINE = 3

export interface ScanStats {
  lines: number
  chars: number
}

const FROM = /\bfrom\s*(["'])([^"'\n]{1,300})\1/g
const SIDE_EFFECT = /^\s*import\s*(["'])([^"'\n]{1,300})\1/
const CALL = /\b(?:require|import)\s*\(\s*(["'])([^"'\n]{1,300})\1\s*\)/g

// Relative specifiers ("./x", "../y") of `import ... from`, `import "x"`, `export ... from`, `require("x")` and
// `import("x")`, in order of appearance, without repeats. Multi-line imports work because `from "x"` ends on one line.
export const extractImportSpecifiers = (text: string, stats?: ScanStats): ReadonlyArray<string> => {
  const found = new Set<string>()
  for (const line of text.split("\n")) {
    if (found.size >= MAX_SPECIFIERS) break
    if (line.length > MAX_LINE_CHARS || line.length === 0) continue
    if (!(line.includes("from") || line.includes("import") || line.includes("require"))) continue
    if (stats !== undefined) {
      stats.lines += 1
      stats.chars += line.length * PATTERNS_PER_LINE
    }
    const matches = [SIDE_EFFECT.exec(line), ...line.matchAll(FROM), ...line.matchAll(CALL)]
    for (const match of matches) {
      const specifier = match?.[2]
      if (specifier?.startsWith(".") && found.size < MAX_SPECIFIERS) {
        found.add(specifier)
      }
    }
  }
  return [...found]
}

const EXTENSIONS: ReadonlyArray<string> = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
]
// "./x.js" in TypeScript ESM names the source "./x.ts".
const SOURCE_OF: Readonly<Record<string, ReadonlyArray<string>>> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
}

// The indexed file a relative specifier of `fromPath` names, or undefined (outside the repo, not indexed).
export const resolveImport = (
  fromPath: string,
  specifier: string,
  known: ReadonlySet<string>,
): string | undefined => {
  const base = posix.normalize(posix.join(posix.dirname(normalizePath(fromPath)), specifier))
  if (base === ".." || base.startsWith("../") || base.startsWith("/")) return undefined
  const candidates: Array<string> = [base]
  const dot = base.lastIndexOf(".")
  const extension = dot > base.lastIndexOf("/") ? base.slice(dot) : ""
  const stem = extension === "" ? base : base.slice(0, dot)
  for (const source of SOURCE_OF[extension] ?? []) candidates.push(`${stem}${source}`)
  for (const ext of EXTENSIONS) candidates.push(`${base}${ext}`)
  for (const ext of EXTENSIONS) candidates.push(`${base}/index${ext}`)
  return candidates.find((candidate) => known.has(candidate))
}

// Undirected: "imports" and "is imported by" weigh the same.
export type Adjacency = Map<string, Set<string>>

export const addEdge = (adjacency: Adjacency, a: string, b: string): void => {
  if (a === b) return
  for (const [from, to] of [
    [a, b],
    [b, a],
  ] as const) {
    const set = adjacency.get(from) ?? new Set<string>()
    set.add(to)
    adjacency.set(from, set)
  }
}

// Files within `hops` import edges of any start file (the starts themselves are left out), with their distance.
export const importDistances = (
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
  starts: ReadonlyArray<string>,
  hops = 2,
): ReadonlyMap<string, number> => {
  const startSet = new Set(starts.map(normalizePath))
  const distances = new Map<string, number>()
  let frontier = [...startSet]
  const seen = new Set(startSet)
  for (let distance = 1; distance <= hops; distance++) {
    const next: Array<string> = []
    for (const path of frontier) {
      for (const neighbor of adjacency.get(path) ?? []) {
        if (!seen.has(neighbor)) {
          seen.add(neighbor)
          distances.set(neighbor, distance)
          next.push(neighbor)
        }
      }
    }
    frontier = next
  }
  return distances
}

const PATH_TOKEN = /[A-Za-z0-9_@.\-/]+/g
const MAX_PATH_CHARS = 200
const MAX_ACTIVE_FILES = 20
const FILE_EXTENSION = /^[A-Za-z0-9]{1,5}$/
const TRAILING: ReadonlySet<string> = new Set([".", "-", "/"])

// Paths named in a prompt: relative tokens whose last segment has a file extension. Absolute paths and URLs are left out.
export const activeFilesFromText = (text: string, stats?: ScanStats): ReadonlyArray<string> => {
  const found = new Set<string>()
  if (stats !== undefined) stats.chars += text.length
  for (const match of text.matchAll(PATH_TOKEN)) {
    if (found.size >= MAX_ACTIVE_FILES) break
    if (stats !== undefined) stats.lines += 1
    // Length first: the trim below must never see a token the size of the whole text.
    if (match[0].length > MAX_PATH_CHARS) continue
    let end = match[0].length
    while (end > 0 && TRAILING.has(match[0].charAt(end - 1))) end -= 1
    const raw = match[0].slice(0, end)
    if (raw.length === 0 || raw.startsWith("/")) continue
    const index = match.index ?? 0
    if (text.slice(Math.max(0, index - 3), index) === "://") continue
    const base = raw.slice(raw.lastIndexOf("/") + 1)
    const dot = base.lastIndexOf(".")
    if (dot <= 0) continue
    const extension = base.slice(dot + 1)
    const plausible = extension.length >= 2 || raw.includes("/")
    if (plausible && FILE_EXTENSION.test(extension) && /[A-Za-z]/.test(extension) && !raw.includes("..")) {
      found.add(normalizePath(raw))
    }
  }
  return [...found]
}
