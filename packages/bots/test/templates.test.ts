import { fileURLToPath } from "node:url"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { type BotTemplate, instantiate, loadTemplates } from "../src/templates.js"

const TEMPLATES = fileURLToPath(new URL("../../../bots/templates/", import.meta.url))

// loadTemplates sorts the directory, so the ten templates come back in alphabetical order.
const ROLES = [
  "architect",
  "devops-github",
  "idea-evaluator",
  "reviewer",
  "scout",
  "task-researcher",
  "testpilot",
  "validator",
  "watcher",
  "worker",
]

const template = (templates: ReadonlyArray<BotTemplate>, name: string): BotTemplate => {
  const found = templates.find((t) => t.bot.name === name)
  if (found === undefined) {
    throw new Error(`template not found: ${name}`)
  }
  return found
}

describe("factory templates", () => {
  it.effect("loads and validates the ten templates", () =>
    Effect.gen(function* () {
      const templates = yield* loadTemplates(TEMPLATES)
      expect(templates.map((t) => t.bot.name)).toEqual(ROLES)
      for (const entry of templates) {
        expect(entry.bot.instructions.length).toBeGreaterThan(0)
        expect(entry.bot).not.toHaveProperty("id")
      }
    }),
  )

  it.effect("carries the tides of the roles that have them", () =>
    Effect.gen(function* () {
      const templates = yield* loadTemplates(TEMPLATES)
      const tides = (name: string) => template(templates, name).tides.map((tide) => tide.name)
      expect(tides("watcher")).toEqual(["issue-opened", "workflow-finished"])
      expect(tides("scout")).toEqual(["morning-scan"])
      expect(tides("validator")).toEqual(["production-check"])
      expect(tides("task-researcher")).toEqual(["issue-labeled"])
      expect(tides("devops-github")).toEqual(["weekly-maintenance"])
      expect(tides("worker")).toEqual([])
    }),
  )

  it.effect("instantiate names a bot <role>-<project> and keeps the template fields", () =>
    Effect.gen(function* () {
      const templates = yield* loadTemplates(TEMPLATES)
      const worker = template(templates, "worker")
      const bot = instantiate(worker, { project: "sandbox" })
      expect(bot.name).toBe("worker-sandbox")
      expect(bot.role).toBe(worker.bot.role)
      expect(bot.policy).toBe("worker")
      expect(bot).not.toHaveProperty("id")
    }),
  )

  it.effect("instantiate applies overrides but never over the derived name", () =>
    Effect.gen(function* () {
      const templates = yield* loadTemplates(TEMPLATES)
      const worker = template(templates, "worker")
      const bot = instantiate(worker, {
        project: "faturium",
        overrides: { budget: { tokens: 1, seconds: 1, usd: 0 }, name: "ignored" },
      })
      expect(bot.name).toBe("worker-faturium")
      expect(bot.budget).toEqual({ tokens: 1, seconds: 1, usd: 0 })
    }),
  )
})
