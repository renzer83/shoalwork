import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { it } from "@effect/vitest"
import { SchemaViolation } from "@shoalwork/contracts"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { loadBotEntries } from "../src/index.js"

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url))

describe("bot yaml tides", () => {
  it.effect(
    "reads a cron tide and an event tide into NewTide, enabled, UTC unless a timezone is given",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "bots-tides-ok-"))
      copyFileSync(`${FIXTURES}tides.yaml`, join(dir, "scout.yaml"))
      return Effect.gen(function* () {
        const [entry] = yield* loadBotEntries(dir)
        expect(entry?.tides.map((tide) => [tide.name, tide.kind, tide.timezone, tide.enabled])).toEqual([
          ["morning", "cron", "UTC", true],
          ["on-open", "event", "UTC", true],
        ])
        expect(entry?.tides[0]?.cronExpr).toBe("0 9 * * 1-5")
        expect(entry?.tides[1]?.eventType).toBe("message.inbound")
        expect(entry?.tides[1]?.eventFilter).toEqual({ "payload.channel": "api" })
        expect(entry?.bot).not.toHaveProperty("tides")
      }).pipe(Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))))
    },
  )

  it.effect("rejects a tide that is both cron and event, naming the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "bots-tides-"))
    const broken = `name: scout
role: scout
instructions: x
kind: auxiliary
executors: { preferred: claude-code, allowed: [claude-code] }
modelTiers: {}
connectors: []
budget: { tokens: 1000, seconds: 600, usd: 1 }
policy: default
tank: { mode: local, host: mac }
memory: { scope: bot }
tides:
  - name: both
    cron: "0 9 * * *"
    on: message.inbound
    task: { title: t, prompt: p, kind: chat, tier: chat, budget: { tokens: 1, seconds: 1, usd: 0.1 } }
`
    writeFileSync(join(dir, "scout.yaml"), broken)
    return Effect.gen(function* () {
      const error = yield* Effect.flip(loadBotEntries(dir))
      expect(error).toBeInstanceOf(SchemaViolation)
      expect(error.where).toBe(join(dir, "scout.yaml"))
    }).pipe(Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))))
  })
})
