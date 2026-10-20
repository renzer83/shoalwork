import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { it } from "@effect/vitest"
import { SchemaViolation } from "@shoalwork/contracts"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { loadBotDir, loadBotFile } from "../src/index.js"

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url))
const REPO_BOTS = fileURLToPath(new URL("../../../bots/", import.meta.url))

describe("loadBotFile", () => {
  it.effect("loads a valid definition as NewBot (no id yet)", () =>
    Effect.gen(function* () {
      const bot = yield* loadBotFile(`${FIXTURES}valid.yaml`)
      expect(bot.name).toBe("scout")
      expect(bot.kind).toBe("auxiliary")
      expect(bot).not.toHaveProperty("id")
    }),
  )

  it.effect("rejects a name with a space with SchemaViolation at the file path", () =>
    Effect.gen(function* () {
      const path = `${FIXTURES}invalid-name.yaml`
      const error = yield* Effect.flip(loadBotFile(path))
      expect(error).toBeInstanceOf(SchemaViolation)
      expect(error.where).toBe(path)
    }),
  )

  it.effect("reports an unreadable file as SchemaViolation at its path", () =>
    Effect.gen(function* () {
      const path = `${FIXTURES}does-not-exist.yaml`
      const error = yield* Effect.flip(loadBotFile(path))
      expect(error).toBeInstanceOf(SchemaViolation)
      expect(error.where).toBe(path)
    }),
  )
})

describe("loadBotDir", () => {
  it.effect("loads the repository bots/ directory, lead included", () =>
    Effect.gen(function* () {
      const bots = yield* loadBotDir(REPO_BOTS)
      const lead = bots.find((bot) => bot.name === "lead")
      expect(lead).toBeDefined()
      expect(lead?.kind).toBe("fixed")
      expect(lead?.role).toBe("coordinator")
    }),
  )

  it.effect("rejects two files that declare the same bot name, naming the second file", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "bots-dup-"))
      try {
        const content = readFileSync(`${FIXTURES}valid.yaml`, "utf8")
        writeFileSync(join(dir, "a.yaml"), content)
        writeFileSync(join(dir, "b.yaml"), content)
        const error = yield* Effect.flip(loadBotDir(dir))
        expect(error).toBeInstanceOf(SchemaViolation)
        expect(error.where).toBe(join(dir, "b.yaml"))
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }),
  )
})
