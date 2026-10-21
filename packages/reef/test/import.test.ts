import { symlinkSync } from "node:fs"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { SchemaViolation } from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import { type ImportOptions, importMarkdownDir } from "../src/import.js"
import { WalkError } from "../src/indexer/walk.js"
import { chunkMarkdown, MAX_CHUNK_CHARS } from "../src/markdown.js"
import {
  CODE_MD,
  createMarkdownDir,
  fakeToken,
  type MarkdownDir,
  NOTES_MD,
  SOUL_MD,
} from "./fixtures/md/files.js"
import { reefStack } from "./support.js"

const Count = Schema.Struct({ n: Schema.Number })
const decodeCount = Schema.decodeUnknownSync(Schema.Array(Count))

const withMarkdownDir = <A, E, R>(
  files: Readonly<Record<string, string>>,
  use: (md: MarkdownDir) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => createMarkdownDir(files)),
    use,
    (md) => Effect.sync(md.cleanup),
  )

const BASE_FILES = { "soul.md": SOUL_MD, "notes.md": NOTES_MD, "code.md": CODE_MD }

const optionsFor = (dir: string, overrides: Partial<ImportOptions> = {}): ImportOptions => ({
  dir,
  scope: "bot",
  ownerId: "bot_lead",
  kind: "semantic",
  source: "soul",
  ...overrides,
})

// Count of live (not superseded, not forgotten) rows, optionally filtered by a substring of the content.
const liveRows = (needle?: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const rows =
      needle === undefined
        ? yield* sql`SELECT count(*) AS n FROM memory_items WHERE superseded_by IS NULL AND tombstone = 0`
        : yield* sql`SELECT count(*) AS n FROM memory_items
            WHERE superseded_by IS NULL AND tombstone = 0 AND instr(content, ${needle}) > 0`
    return decodeCount(rows)[0]?.n ?? -1
  })

const allRowsContaining = (needle: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const rows = yield* sql`SELECT count(*) AS n FROM memory_items WHERE instr(content, ${needle}) > 0`
    return decodeCount(rows)[0]?.n ?? -1
  })

describe("chunkMarkdown", () => {
  it("removes the YAML frontmatter and keeps each heading with its body", () => {
    const chunks = chunkMarkdown(SOUL_MD)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]?.startsWith("# Lead")).toBe(true)
    expect(chunks[1]?.startsWith("## Regras")).toBe(true)
    expect(chunks.join("\n")).not.toContain("name: lead")
  })

  it("replaces a code block longer than 40 lines with a placeholder and keeps shorter ones", () => {
    const long = chunkMarkdown(CODE_MD).join("\n")
    expect(long).toContain("[code omitted: 45 lines]")
    expect(long).not.toContain("const line0 = 0")
    const short = chunkMarkdown(["# Short", "", "```ts", "const a = 1", "```"].join("\n")).join("\n")
    expect(short).toContain("const a = 1")
    expect(short).not.toContain("[code omitted")
  })

  it("does not start a section on a # line inside a fenced block", () => {
    const text = ["# Real", "", "```sh", "# comment inside code", "echo hi", "```"].join("\n")
    expect(chunkMarkdown(text)).toHaveLength(1)
  })

  it("keeps every chunk within the size limit and repeats one paragraph as overlap", () => {
    const text = ["# Long", "", "p".repeat(600), "", "q".repeat(600), "", "r".repeat(600), ""].join("\n")
    const chunks = chunkMarkdown(text)
    expect(chunks.every((chunk) => chunk.length <= MAX_CHUNK_CHARS)).toBe(true)
    expect(chunks).toHaveLength(2)
    expect(chunks[1]?.startsWith("q".repeat(600))).toBe(true)
    expect(chunks[1]?.includes("r".repeat(600))).toBe(true)
  })

  it("splits one paragraph longer than the limit without losing characters", () => {
    const text = `# Big\n\n${"z".repeat(4000)}\n`
    const chunks = chunkMarkdown(text)
    expect(chunks.every((chunk) => chunk.length <= MAX_CHUNK_CHARS)).toBe(true)
    expect(chunks.join("").replace(/[^z]/g, "")).toHaveLength(4000)
  })

  it("answers hostile 200 KB inputs without failing", () => {
    const inputs = [
      "#".repeat(200_000),
      "`".repeat(200_000),
      "x\n".repeat(100_000),
      "# a\n\n```\n".repeat(20_000),
    ]
    for (const input of inputs) {
      expect(chunkMarkdown(input).length).toBeGreaterThan(0)
    }
  })
})

describe("importMarkdownDir", () => {
  it.effect("imports three files into the expected number of memories", () =>
    withMarkdownDir(BASE_FILES, (md) =>
      Effect.gen(function* () {
        const report = yield* importMarkdownDir(optionsFor(md.dir))
        expect(report).toMatchObject({
          files: 3,
          chunks: 7,
          created: 7,
          superseded: 0,
          unchanged: 0,
          forgotten: 0,
          skipped: [],
          rejected: [],
        })
        expect(yield* liveRows()).toBe(7)
      }),
    ).pipe(Effect.provide(reefStack())),
  )

  it.effect("reimporting unchanged files writes nothing new", () =>
    withMarkdownDir(BASE_FILES, (md) =>
      Effect.gen(function* () {
        yield* importMarkdownDir(optionsFor(md.dir))
        const again = yield* importMarkdownDir(optionsFor(md.dir))
        expect(again).toMatchObject({ created: 0, superseded: 0, forgotten: 0, unchanged: 7, chunks: 7 })
        expect(yield* liveRows()).toBe(7)
      }),
    ).pipe(Effect.provide(reefStack())),
  )

  it.effect("an edited chunk supersedes only its predecessor", () =>
    withMarkdownDir(BASE_FILES, (md) =>
      Effect.gen(function* () {
        yield* importMarkdownDir(optionsFor(md.dir))
        md.write(
          "soul.md",
          SOUL_MD.replace("Nunca executa código diretamente.", "Nunca executa código, nem por engano."),
        )
        const report = yield* importMarkdownDir(optionsFor(md.dir))
        expect(report).toMatchObject({ superseded: 1, created: 0, unchanged: 6, forgotten: 0 })
        expect(yield* liveRows()).toBe(7)
        expect(yield* liveRows("nem por engano")).toBe(1)
        expect(yield* liveRows("executa código diretamente")).toBe(0)
      }),
    ).pipe(Effect.provide(reefStack())),
  )

  it.effect("a removed file is forgotten together with all its chunks", () =>
    withMarkdownDir(BASE_FILES, (md) =>
      Effect.gen(function* () {
        yield* importMarkdownDir(optionsFor(md.dir))
        md.remove("notes.md")
        const report = yield* importMarkdownDir(optionsFor(md.dir))
        expect(report).toMatchObject({ files: 2, chunks: 3, created: 0, superseded: 0, forgotten: 4 })
        expect(yield* liveRows()).toBe(3)
      }),
    ).pipe(Effect.provide(reefStack())),
  )

  it.effect("rejects a file that carries a token-shaped secret and never stores its content", () => {
    const token = fakeToken()
    return withMarkdownDir({ ...BASE_FILES, "leak.md": `# Deploy\n\nUse ${token} to deploy.\n` }, (md) =>
      Effect.gen(function* () {
        const report = yield* importMarkdownDir(optionsFor(md.dir))
        expect(report.rejected).toEqual(["leak.md"])
        expect(report.files).toBe(3)
        expect(yield* allRowsContaining(token)).toBe(0)
      }),
    ).pipe(Effect.provide(reefStack()))
  })

  it.effect("stores the body and not the YAML frontmatter", () =>
    withMarkdownDir({ "soul.md": SOUL_MD }, (md) =>
      Effect.gen(function* () {
        yield* importMarkdownDir(optionsFor(md.dir))
        expect(yield* allRowsContaining("name: lead")).toBe(0)
        expect(yield* allRowsContaining("Coordena os bots")).toBe(1)
      }),
    ).pipe(Effect.provide(reefStack())),
  )

  it.effect("skips a symlink whose target lies outside the directory", () =>
    withMarkdownDir({ "soul.md": SOUL_MD }, (md) =>
      withMarkdownDir({ "secret-outside.md": "# Outside\n\nnot yours\n" }, (outside) =>
        Effect.gen(function* () {
          symlinkSync(join(outside.dir, "secret-outside.md"), join(md.dir, "link.md"))
          const report = yield* importMarkdownDir(optionsFor(md.dir))
          expect(report.skipped).toEqual([{ path: "link.md", reason: "outside_root" }])
          expect(report.files).toBe(1)
          expect(yield* allRowsContaining("not yours")).toBe(0)
        }),
      ),
    ).pipe(Effect.provide(reefStack())),
  )

  it.effect("does not read node_modules, .git or .obsidian", () =>
    withMarkdownDir(
      {
        ...BASE_FILES,
        "node_modules/pkg/README.md": "# Pkg\n\nvendored\n",
        ".obsidian/workspace.md": "# Layout\n\nui state\n",
        ".git/notes.md": "# Git\n\ninternal\n",
      },
      (md) =>
        Effect.gen(function* () {
          const report = yield* importMarkdownDir(optionsFor(md.dir))
          expect(report.files).toBe(3)
          expect(report.skipped).toEqual([])
          expect(yield* allRowsContaining("vendored")).toBe(0)
          expect(yield* allRowsContaining("internal")).toBe(0)
        }),
    ).pipe(Effect.provide(reefStack())),
  )

  it.effect("prunes the excluded directory names at any depth", () =>
    withMarkdownDir(
      {
        ...BASE_FILES,
        "templates/daily.md": "# Template\n\nblank daily\n",
        "projects/templates/card.md": "# Card\n\nblank card\n",
        "projects/plan.md": "# Plan\n\nreal plan\n",
      },
      (md) =>
        Effect.gen(function* () {
          const report = yield* importMarkdownDir(optionsFor(md.dir, { exclude: ["templates"] }))
          expect(report.files).toBe(4)
          expect(yield* allRowsContaining("blank")).toBe(0)
          expect(yield* allRowsContaining("real plan")).toBeGreaterThan(0)
        }),
    ).pipe(Effect.provide(reefStack())),
  )

  it.effect("rejects an exclude name with separators", () =>
    withMarkdownDir(BASE_FILES, (md) =>
      Effect.gen(function* () {
        const error = yield* importMarkdownDir(optionsFor(md.dir, { exclude: ["a/b"] })).pipe(Effect.flip)
        expect(error).toBeInstanceOf(SchemaViolation)
      }),
    ).pipe(Effect.provide(reefStack())),
  )

  it.effect("keeps the memories of another label untouched", () =>
    withMarkdownDir({ "soul.md": SOUL_MD }, (soul) =>
      withMarkdownDir({ "vault.md": "# Vault\n\nnota do cofre\n" }, (vault) =>
        Effect.gen(function* () {
          yield* importMarkdownDir(optionsFor(soul.dir))
          yield* importMarkdownDir(optionsFor(vault.dir, { source: "vault" }))
          const report = yield* importMarkdownDir(optionsFor(soul.dir))
          expect(report).toMatchObject({ forgotten: 0, created: 0, unchanged: 2 })
          expect(yield* liveRows("nota do cofre")).toBe(1)
        }),
      ),
    ).pipe(Effect.provide(reefStack())),
  )

  it.effect("rejects a relative directory and a source label with separators", () =>
    Effect.gen(function* () {
      const relative = yield* importMarkdownDir(optionsFor("relative/dir")).pipe(Effect.flip)
      expect(relative).toBeInstanceOf(SchemaViolation)
      const label = yield* importMarkdownDir(optionsFor("/tmp", { source: "a:b" })).pipe(Effect.flip)
      expect(label).toBeInstanceOf(SchemaViolation)
    }).pipe(Effect.provide(reefStack())),
  )

  it.effect("fails with a WalkError when the directory does not exist", () =>
    Effect.gen(function* () {
      const failure = yield* importMarkdownDir(optionsFor("/nonexistent-shoalwork-import-dir")).pipe(
        Effect.flip,
      )
      expect(failure).toBeInstanceOf(WalkError)
      expect(failure).toMatchObject({ reason: "io" })
    }).pipe(Effect.provide(reefStack())),
  )

  it.effect("rejects a global scope that names an owner other than global", () =>
    withMarkdownDir({ "soul.md": SOUL_MD }, (md) =>
      Effect.gen(function* () {
        const failure = yield* importMarkdownDir(optionsFor(md.dir, { scope: "global" })).pipe(Effect.flip)
        expect(failure).toBeInstanceOf(SchemaViolation)
      }),
    ).pipe(Effect.provide(reefStack())),
  )
})
