import { describe, expect, it } from "vitest"
import {
  chunkFile,
  MAX_CHUNK_CHARS,
  MAX_LINE_CHARS,
  MAX_SYMBOL_CHUNK_LINES,
  sha256Hex,
} from "../../src/indexer/chunk.js"
import { findSymbols, langOf } from "../../src/indexer/symbols.js"
import { APP_TS, LIB_RS, NOTES_MD, UTIL_PY } from "../fixtures/repo/files.js"

const ranges = (lang: Parameters<typeof chunkFile>[0], content: string) =>
  chunkFile(lang, content).map((chunk) => [chunk.startLine, chunk.endLine, [...chunk.symbols]])

describe("langOf", () => {
  it("maps extensions to languages and falls back to text", () => {
    expect(langOf("src/a.ts")).toBe("ts")
    expect(langOf("src/a.tsx")).toBe("ts")
    expect(langOf("a.mjs")).toBe("js")
    expect(langOf("tools/x.py")).toBe("py")
    expect(langOf("lib.rs")).toBe("rs")
    expect(langOf("notes.md")).toBe("md")
    expect(langOf("Makefile")).toBe("text")
    expect(langOf(".gitignore")).toBe("text")
  })
})

describe("findSymbols", () => {
  it("finds top-level ts declarations and ignores indented ones", () => {
    const lines = [
      "export async function load() {}",
      "function* gen() {}",
      "const inner = 1",
      "  const nested = 2",
      "export let counter = 0",
      "export class Box {}",
      "interface Skipped {}",
    ]
    expect(findSymbols("ts", lines).map((hit) => hit.name)).toEqual([
      "load",
      "gen",
      "inner",
      "counter",
      "Box",
    ])
  })

  it("finds python and rust declarations", () => {
    expect(
      findSymbols("py", ["def a():", "    def inner():", "async def b():", "class C:"]).map((h) => h.name),
    ).toEqual(["a", "b", "C"])
    expect(
      findSymbols("rs", [
        "pub fn run() {}",
        "struct S;",
        "pub(crate) enum E {}",
        "trait T {}",
        "impl S {}",
      ]).map((h) => h.name),
    ).toEqual(["run", "S", "E", "T", "S"])
  })

  it("matches hostile lines without failing and ignores lines over the length limit", () => {
    const hostile = [
      `export function${" ".repeat(200_000)}`,
      `export async function ${"*".repeat(200_000)}`,
      `function${" ".repeat(900)}*${" ".repeat(50)}`,
      `export const ${"a".repeat(200_000)}`,
    ]
    expect(findSymbols("ts", hostile)).toEqual([])
  })

  it("returns nothing for languages without patterns", () => {
    expect(findSymbols("md", ["function nope() {}"])).toEqual([])
  })
})

describe("chunkFile", () => {
  it("splits typescript by declaration with the preamble as a chunk without symbols", () => {
    expect(ranges("ts", APP_TS)).toEqual([
      [1, 1, []],
      [3, 5, ["alpha"]],
      [7, 9, ["beta"]],
      [11, 13, ["Gamma"]],
    ])
  })

  it("splits python and rust by declaration", () => {
    expect(ranges("py", UTIL_PY)).toEqual([
      [1, 1, []],
      [3, 4, ["load"]],
      [6, 7, ["fetch_all"]],
      [9, 10, ["Store"]],
    ])
    expect(ranges("rs", LIB_RS)).toEqual([
      [1, 1, []],
      [3, 5, ["compute"]],
      [7, 9, ["Point"]],
      [11, 13, ["Point"]],
    ])
  })

  it("uses windows of 60 lines with 10 lines of overlap when there are no symbols", () => {
    expect(ranges("md", NOTES_MD)).toEqual([
      [1, 60, []],
      [51, 70, []],
    ])
    const long = Array.from({ length: 111 }, (_, index) => `l${index + 1}`).join("\n")
    expect(chunkFile("text", long).map((chunk) => [chunk.startLine, chunk.endLine])).toEqual([
      [1, 60],
      [51, 110],
      [101, 111],
    ])
  })

  it("falls back to windows for a code file with no declarations", () => {
    const content = Array.from({ length: 5 }, (_, index) => `  value ${index}`).join("\n")
    expect(ranges("ts", content)).toEqual([[1, 5, []]])
  })

  it("cuts a very long declaration into windows that keep the symbol name", () => {
    const body = Array.from({ length: MAX_SYMBOL_CHUNK_LINES + 20 }, (_, index) => `  step(${index})`)
    const content = ["export function huge() {", ...body, "}"].join("\n")
    const chunks = chunkFile("ts", content)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((chunk) => chunk.symbols.join() === "huge")).toBe(true)
    expect(chunks[0]?.startLine).toBe(1)
    expect(chunks[chunks.length - 1]?.endLine).toBe(body.length + 2)
  })

  it("returns no chunks for empty or blank files and handles CRLF", () => {
    expect(chunkFile("ts", "")).toEqual([])
    expect(chunkFile("ts", "\n\n   \n")).toEqual([])
    const crlf = chunkFile("ts", "export function a() {\r\n  return 1\r\n}\r\n")
    expect(crlf).toHaveLength(1)
    expect(crlf[0]?.content).toBe("export function a() {\n  return 1\n}")
  })

  it("bounds chunks by characters: long lines are cut and windows shrink to the budget", () => {
    const long = "x".repeat(5000)
    const content = Array.from({ length: 30 }, () => long).join("\n")
    const chunks = chunkFile("text", content)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS)
      expect(chunk.content.split("\n").every((line) => line.length <= MAX_LINE_CHARS)).toBe(true)
    }
    const starts = chunks.map((chunk) => chunk.startLine)
    expect(new Set(starts).size).toBe(starts.length)
    expect([...starts].sort((a, b) => a - b)).toEqual(starts)
    expect(chunks[chunks.length - 1]?.endLine).toBe(30)
  })

  it("splits a declaration that exceeds the character budget into bounded windows", () => {
    const body = Array.from({ length: 40 }, () => `  call("${"y".repeat(400)}")`)
    const chunks = chunkFile("ts", ["export function wide() {", ...body, "}"].join("\n"))
    expect(chunks.length).toBeGreaterThan(1)
    expect(
      chunks.every((chunk) => chunk.content.length <= MAX_CHUNK_CHARS && chunk.symbols[0] === "wide"),
    ).toBe(true)
  })

  it("chunks a hostile 200 KB line into bounded chunks", () => {
    const chunks = chunkFile("ts", `export function${" ".repeat(200_000)}\n`)
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.every((chunk) => chunk.content.length <= MAX_CHUNK_CHARS)).toBe(true)
  })

  it("hashes the chunk content with sha256", () => {
    const [chunk] = chunkFile("ts", "export function a() {}\n")
    expect(chunk?.sha256).toBe(sha256Hex("export function a() {}"))
  })
})
