import { describe, expect, it } from "vitest"
import {
  activeFilesFromText,
  addEdge,
  extractImportSpecifiers,
  importDistances,
  MAX_LINE_CHARS,
  MAX_SPECIFIERS,
  PATTERNS_PER_LINE,
  resolveImport,
  type ScanStats,
} from "../../src/rank/imports.js"

describe("extractImportSpecifiers", () => {
  it("reads relative specifiers from every import form", () => {
    const text = [
      'import { a } from "./a.js"',
      "import b from '../b'",
      'import "./side-effect"',
      'export * from "./re-export"',
      'const c = require("./c")',
      'const d = await import("./d")',
      'import pkg from "some-package"',
      'import node from "node:fs"',
    ].join("\n")
    expect(extractImportSpecifiers(text)).toEqual([
      "./a.js",
      "../b",
      "./side-effect",
      "./re-export",
      "./c",
      "./d",
    ])
  })

  it("reads a multi-line import from its closing line and drops repeats", () => {
    const text = 'import {\n  one,\n  two,\n} from "./many"\nimport { x } from "./many"\n'
    expect(extractImportSpecifiers(text)).toEqual(["./many"])
  })

  it("stops at the specifier cap", () => {
    const text = Array.from({ length: MAX_SPECIFIERS + 50 }, (_, i) => `import x from "./f${i}"`).join("\n")
    expect(extractImportSpecifiers(text)).toHaveLength(MAX_SPECIFIERS)
  })
})

const HOSTILE_SIZE = 200 * 1024

const hostileInputs: ReadonlyArray<readonly [string, string]> = [
  ["one huge line of from", "from      ".repeat(HOSTILE_SIZE / 10)],
  ["one huge line of import", "import ".repeat(HOSTILE_SIZE / 7)],
  ["max-size lines of from and spaces", `${"from".padEnd(9, " ").repeat(110)}\n`.repeat(HOSTILE_SIZE / 1000)],
  ["unterminated quotes", `${'import ("'.repeat(110)}\n`.repeat(HOSTILE_SIZE / 1000)],
  ["require without closing", `${"require(  ".repeat(100)}\n`.repeat(HOSTILE_SIZE / 1000)],
  ["only newlines", "\n".repeat(HOSTILE_SIZE)],
  ["spaces after import", `import${" ".repeat(990)}\n`.repeat(HOSTILE_SIZE / 1000)],
]

describe("hostile repo text", () => {
  for (const [name, text] of hostileInputs) {
    it(`scans ${name} in work proportional to its size`, () => {
      expect(text.length).toBeGreaterThanOrEqual(190_000)
      const stats: ScanStats = { lines: 0, chars: 0 }
      expect(extractImportSpecifiers(text, stats)).toEqual([])
      // Every character reaches at most PATTERNS_PER_LINE patterns, and lines over the cap reach none.
      expect(stats.chars).toBeLessThanOrEqual(PATTERNS_PER_LINE * text.length)
      expect(stats.lines).toBeLessThanOrEqual(Math.ceil(text.length / 2))

      const doubled: ScanStats = { lines: 0, chars: 0 }
      extractImportSpecifiers(text + text, doubled)
      expect(doubled.chars).toBeLessThanOrEqual(2 * stats.chars + PATTERNS_PER_LINE * MAX_LINE_CHARS)
    })
  }

  it("skips lines over the cap without handing them to any pattern", () => {
    const stats: ScanStats = { lines: 0, chars: 0 }
    extractImportSpecifiers(`import x from "./a" ${"x".repeat(MAX_LINE_CHARS)}`, stats)
    expect(stats).toEqual({ lines: 0, chars: 0 })
  })

  it("finds paths in a hostile prompt in one pass over its tokens", () => {
    const text = ".".repeat(HOSTILE_SIZE) + "a./".repeat(HOSTILE_SIZE / 3)
    const stats: ScanStats = { lines: 0, chars: 0 }
    expect(activeFilesFromText(text, stats)).toEqual([])
    expect(stats.lines).toBeLessThanOrEqual(text.length)
    expect(stats.chars).toBe(text.length)
  })
})

describe("resolveImport", () => {
  const known = new Set([
    "src/a.ts",
    "src/b.tsx",
    "src/util/index.ts",
    "src/data.json",
    "lib/c.mts",
    "top.ts",
  ])

  it("resolves extensions, the .js to .ts convention and index files", () => {
    expect(resolveImport("src/x.ts", "./a.js", known)).toBe("src/a.ts")
    expect(resolveImport("src/x.ts", "./a", known)).toBe("src/a.ts")
    expect(resolveImport("src/x.ts", "./b", known)).toBe("src/b.tsx")
    expect(resolveImport("src/x.ts", "./util", known)).toBe("src/util/index.ts")
    expect(resolveImport("src/x.ts", "./data.json", known)).toBe("src/data.json")
    expect(resolveImport("src/x.ts", "../lib/c.mjs", known)).toBe("lib/c.mts")
    expect(resolveImport("src/deep/y.ts", "../../top", known)).toBe("top.ts")
  })

  it("returns undefined for files that are not indexed or lie outside the repo", () => {
    expect(resolveImport("src/x.ts", "./missing", known)).toBeUndefined()
    expect(resolveImport("src/x.ts", "../../outside", known)).toBeUndefined()
    expect(resolveImport("top.ts", "../up", known)).toBeUndefined()
  })
})

describe("importDistances", () => {
  it("measures up to two hops in both directions, leaving out the start files", () => {
    const adjacency = new Map<string, Set<string>>()
    addEdge(adjacency, "a.ts", "b.ts")
    addEdge(adjacency, "b.ts", "c.ts")
    addEdge(adjacency, "c.ts", "d.ts")
    addEdge(adjacency, "e.ts", "a.ts")
    const distances = importDistances(adjacency, ["./a.ts"])
    expect([...distances.entries()].sort()).toEqual([
      ["b.ts", 1],
      ["c.ts", 2],
      ["e.ts", 1],
    ])
  })
})

describe("activeFilesFromText", () => {
  it("picks relative file paths from a prompt and ignores urls, absolute paths and versions", () => {
    const prompt =
      "Fix src/rank/ranker.ts and ./packages/lead/src/context/briefing.ts, see https://example.com/docs/page.html, " +
      "/etc/passwd.conf, version 1.2.3, e.g. this. Also config/context.yaml."
    expect(activeFilesFromText(prompt)).toEqual([
      "src/rank/ranker.ts",
      "packages/lead/src/context/briefing.ts",
      "config/context.yaml",
    ])
  })

  it("keeps at most 20 files", () => {
    const prompt = Array.from({ length: 40 }, (_, i) => `src/f${i}.ts`).join(" ")
    expect(activeFilesFromText(prompt)).toHaveLength(20)
  })
})
