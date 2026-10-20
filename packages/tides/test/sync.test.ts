import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { BotRegistry } from "@shoalwork/bots"
import { withTempDb } from "@shoalwork/db/testing"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { Tides } from "../src/index.js"
import { type Intake, tidesEnv } from "./support.js"

const BOT_WITH_TIDES = `name: scout
role: scout
instructions: look around
kind: auxiliary
executors: { preferred: claude-code, allowed: [claude-code] }
modelTiers: {}
connectors: []
budget: { tokens: 1000, seconds: 600, usd: 1 }
policy: default
tank: { mode: local, host: mac }
memory: { scope: bot }
tides:
  - name: morning
    cron: "0 9 * * 1-5"
    timezone: America/Sao_Paulo
    task: { title: "Morning check", prompt: "Look at the queue", kind: research, tier: light, budget: { tokens: 500, seconds: 300, usd: 0.5 } }
  - name: on-open
    on: message.inbound
    filter: { "payload.channel": "api" }
    task: { title: "Reply {{payload.userId}}", prompt: "Answer {{payload.text}}", kind: chat, tier: chat, budget: { tokens: 500, seconds: 300, usd: 0.5 } }
`

describe("bot yaml tides", () => {
  it.effect(
    "syncing the same directory twice upserts the same tides, keeping ids and the switched-off state",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "tides-sync-"))
      const intakes: Array<Intake> = []
      const env = tidesEnv(withTempDb(), intakes, { botBudgetWindowMs: 86_400_000 })
      return Effect.gen(function* () {
        writeFileSync(join(dir, "scout.yaml"), BOT_WITH_TIDES)
        const registry = yield* BotRegistry
        const tides = yield* Tides
        yield* registry.syncFromDir(dir)
        const first = yield* tides.syncFromDir(dir)
        expect(first).toHaveLength(2)
        const ids = first.map((tide) => tide.id)
        const disabled = first.find((tide) => tide.name === "on-open")
        if (disabled === undefined) return yield* Effect.die("on-open tide missing")
        yield* tides.enable(disabled.id, false)
        yield* registry.syncFromDir(dir)
        const second = yield* tides.syncFromDir(dir)
        expect(second.map((tide) => tide.id)).toEqual(ids)
        const stored = yield* tides.list()
        expect(stored).toHaveLength(2)
        expect(stored.find((tide) => tide.name === "on-open")?.enabled).toBe(false)
        expect(stored.find((tide) => tide.name === "morning")?.cronExpr).toBe("0 9 * * 1-5")
      }).pipe(
        Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
        Effect.provide(env),
      )
    },
  )
})
