import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { UsageError } from "../src/args.js"
import { botFromTemplate, botList } from "../src/commands/bot.js"

const TEMPLATES = fileURLToPath(new URL("../../../bots/templates/", import.meta.url))

// A root that mirrors the repo layout: bots/ (empty) and bots/templates/ (the real templates).
const makeRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "bot-cli-"))
  mkdirSync(join(root, "bots"))
  cpSync(TEMPLATES, join(root, "bots/templates"), { recursive: true })
  return root
}

const clean = (root: string) => Effect.sync(() => rmSync(root, { recursive: true, force: true }))

describe("bot commands", () => {
  it.effect("from-template writes bots/<role>-<project>.yaml and list shows it", () => {
    const root = makeRoot()
    return Effect.gen(function* () {
      const path = yield* botFromTemplate(root, "worker", "sandbox")
      expect(path).toBe(join(root, "bots", "worker-sandbox.yaml"))
      expect(existsSync(path)).toBe(true)
      const names = yield* botList(root)
      expect(names).toContain("worker-sandbox")
    }).pipe(Effect.ensuring(clean(root)))
  })

  it.effect("from-template rejects an unknown template", () => {
    const root = makeRoot()
    return Effect.gen(function* () {
      const error = yield* Effect.flip(botFromTemplate(root, "nope", "sandbox"))
      expect(error).toBeInstanceOf(UsageError)
      expect(error.message).toContain("unknown template")
    }).pipe(Effect.ensuring(clean(root)))
  })

  it.effect("from-template rejects a project that is not a slug", () => {
    const root = makeRoot()
    return Effect.gen(function* () {
      const error = yield* Effect.flip(botFromTemplate(root, "worker", "Not A Slug"))
      expect(error).toBeInstanceOf(UsageError)
      expect(error.message).toContain("invalid bot name")
    }).pipe(Effect.ensuring(clean(root)))
  })

  it.effect("from-template refuses to overwrite an existing bot", () => {
    const root = makeRoot()
    return Effect.gen(function* () {
      yield* botFromTemplate(root, "worker", "sandbox")
      const error = yield* Effect.flip(botFromTemplate(root, "worker", "sandbox"))
      expect(error).toBeInstanceOf(UsageError)
      expect(error.message).toContain("already exists")
    }).pipe(Effect.ensuring(clean(root)))
  })
})
