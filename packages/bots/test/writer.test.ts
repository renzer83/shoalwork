import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { NewBot, SchemaViolation } from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import { describe, expect } from "vitest"
import { BotFileExists, loadBotFile, writeBotYaml } from "../src/index.js"

const decodeBot = (over: Readonly<Record<string, unknown>> = {}): NewBot =>
  Schema.decodeUnknownSync(NewBot)({
    name: "marketing-faturium",
    role: "marketing",
    kind: "auxiliary",
    instructions: "You write short campaigns for Faturium.",
    executors: { preferred: "claude-code", allowed: ["claude-code"] },
    modelTiers: {},
    connectors: [],
    budget: { tokens: 500000, seconds: 1800, usd: 5 },
    policy: "default",
    tank: { mode: "local", host: "mac" },
    memory: { scope: "bot" },
    ...over,
  })

// A fresh bots/ directory per test; removed when the test ends.
const withDir = <A, E, R>(body: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "bots-writer-"))),
    body,
    (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  )

describe("writeBotYaml", () => {
  it.effect("writes bots/<name>.yaml that loadBotFile reads back as the same definition", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const bot = decodeBot()
        const path = yield* writeBotYaml(dir, bot)
        expect(path).toBe(join(dir, "marketing-faturium.yaml"))
        const loaded = yield* loadBotFile(path)
        expect(loaded).toEqual(bot)
      }),
    ),
  )

  it.effect("leaves no temp file behind after a successful write", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        yield* writeBotYaml(dir, decodeBot())
        expect(readdirSync(dir)).toEqual(["marketing-faturium.yaml"])
      }),
    ),
  )

  it.effect("refuses to overwrite an existing Bot file and keeps its content", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const path = join(dir, "marketing-faturium.yaml")
        writeFileSync(path, "name: keep-me\n")
        const error = yield* Effect.flip(writeBotYaml(dir, decodeBot()))
        expect(error).toBeInstanceOf(BotFileExists)
        expect(error).toMatchObject({ path })
        expect(readFileSync(path, "utf8")).toBe("name: keep-me\n")
      }),
    ),
  )

  it.effect("rejects a name that would escape the directory, and writes nothing", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const valid = decodeBot()
        const error = yield* Effect.flip(writeBotYaml(dir, { ...valid, name: "../escape" }))
        expect(error).toBeInstanceOf(SchemaViolation)
        expect(readdirSync(dir)).toEqual([])
      }),
    ),
  )

  it.effect("rejects an invalid definition with SchemaViolation and writes nothing", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const valid = decodeBot()
        const error = yield* Effect.flip(writeBotYaml(dir, { ...valid, name: "x" }))
        expect(error).toBeInstanceOf(SchemaViolation)
        expect(readdirSync(dir)).toEqual([])
      }),
    ),
  )
})
