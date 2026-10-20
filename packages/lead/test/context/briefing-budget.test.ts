import { it } from "@effect/vitest"
import { Bot, type ModelTier, TankError } from "@shoalwork/contracts"
import { Cause, Effect, Schema } from "effect"
import { describe, expect } from "vitest"
import type { BriefingCode, BriefingMemory } from "../../src/context/briefing.js"
import { estimateTokens } from "../../src/context/tokens.js"
import {
  absent,
  build,
  buildFor,
  chunk,
  config,
  files,
  fixtureCode,
  fixtureMemory,
  hit,
  repo,
  withSpec,
  worktreeCtx,
} from "./briefing-support.js"
import { bot } from "./fixtures.js"

const TIERS: ReadonlyArray<ModelTier> = ["chat", "decision", "light", "heavy"]

// Every source at its largest: a Bot with 6000 chars of instructions, 100 criteria, rules sections and big hits.
const crowded = (tier: ModelTier, kind: string) => {
  const big = Schema.decodeUnknownSync(Bot)({ ...bot, instructions: "i".repeat(6000) })
  const task = withSpec({
    kind,
    tier,
    repo,
    prompt: "Add tests for the parser and the deploy code style",
    acceptance: Array.from({ length: 100 }, (_, i) => `criterion number ${i} ${"c".repeat(60)}`),
  })
  const sections = ["Testing", "Parser", "Deploy", "Code style"]
    .map((heading) => `# ${heading}\n${"rule text ".repeat(200)}`)
    .join("\n")
  const { memory } = fixtureMemory(Array.from({ length: 8 }, (_, i) => hit(`m${i}`, "m".repeat(400), i)))
  const { code } = fixtureCode(Array.from({ length: 6 }, (_, i) => chunk(`f${i}.ts`, "c".repeat(2000), i)))
  return buildFor(big, task, { memory, code, tank: files({ "CLAUDE.md": sections }) }, worktreeCtx, {
    complexity: 4,
  })
}

describe("buildBriefing budget", () => {
  it.effect("keeps to the tier's budget minus the answer reserve, on every tier and kind", () =>
    Effect.gen(function* () {
      for (const tier of TIERS) {
        for (const kind of ["chat", "code", "research", "app_op", "routine", "system"]) {
          const briefing = yield* crowded(tier, kind)
          expect(briefing.budget).toBe(config.budget[tier] - config.reserve_for_answer)
          expect(briefing.used).toBe(estimateTokens(briefing.text))
          expect(briefing.used).toBeLessThanOrEqual(briefing.budget)
          // What had to go is reported: the Bot's long instructions and the criteria at least.
          expect(briefing.dropped.map((d) => d.block)).toEqual(
            expect.arrayContaining(["instructions", "acceptance"]),
          )
        }
      }
    }),
  )

  it.effect("fits a small tier by dropping memory and code before anything fixed", () =>
    Effect.gen(function* () {
      const briefing = yield* crowded("light", "code")
      expect(briefing.used).toBeLessThanOrEqual(briefing.budget)
      expect(briefing.text).toContain("# Current task")
      expect(briefing.text).toContain("## Ground rules")
    }),
  )

  it.effect("the Role block is the same for every task of a Bot, so it is a cacheable prefix", () =>
    Effect.gen(function* () {
      const { memory: first } = fixtureMemory([hit("a", "one fact")])
      const { memory: second } = fixtureMemory([hit("b", "another fact")])
      const a = yield* build(withSpec({ kind: "code", tier: "heavy", title: "First" }), { memory: first })
      const b = yield* build(withSpec({ kind: "code", tier: "heavy", title: "Second" }), { memory: second })
      const role = (text: string) => text.slice(0, text.indexOf("\n\n#"))
      expect(role(a.text)).toBe(role(b.text))
      expect(a.text).not.toBe(b.text)
    }),
  )

  it.effect("with the same rules, everything before the memory is the same for two tasks", () =>
    Effect.gen(function* () {
      const tank = files({ "CLAUDE.md": "# Testing\nRun pnpm test." })
      const run = (title: string, fact: string) =>
        build(
          withSpec({ kind: "code", repo, tier: "heavy", title, prompt: "Add tests" }),
          { tank, memory: fixtureMemory([hit("m", fact)]).memory },
          worktreeCtx,
        )
      const a = yield* run("First", "one fact")
      const b = yield* run("Second", "another fact")
      const prefix = (text: string) => text.slice(0, text.indexOf("# Project memory"))
      expect(prefix(a.text)).toContain("# Repository rules")
      expect(prefix(a.text)).toBe(prefix(b.text))
      expect(a.text).not.toBe(b.text)
    }),
  )

  it.effect("a source that fails is reported and left out; the briefing is still built", () =>
    Effect.gen(function* () {
      const reported: Array<string> = []
      const failing: BriefingMemory = { search: () => Effect.die("database gone") }
      const brokenCode: BriefingCode = () => Effect.fail("index offline")
      const briefing = yield* build(
        withSpec({ kind: "code", repo, tier: "heavy" }),
        {
          memory: failing,
          code: brokenCode,
          tank: { readFile: () => Effect.die("tank gone") },
          onSourceError: (source) =>
            Effect.sync(() => {
              reported.push(source)
            }),
        },
        worktreeCtx,
      )
      expect(reported.sort()).toEqual(["code", "memory", "rules"])
      expect(briefing.text).toContain("# Current task")
    }),
  )

  it.effect("a missing rules file is no rules; any other read failure is reported", () =>
    Effect.gen(function* () {
      const reported: Array<string> = []
      const onSourceError = (source: string) =>
        Effect.sync(() => {
          reported.push(source)
        })
      const task = withSpec({ kind: "code", repo, tier: "heavy", prompt: "Add tests" })
      yield* build(task, { tank: { readFile: () => Effect.fail(absent()) }, onSourceError }, worktreeCtx)
      expect(reported).toEqual([])
      const denied = Object.assign(new Error("denied"), { code: "EACCES" })
      const tank = {
        readFile: () => Effect.fail(new TankError({ op: "readFile", cause: denied })),
      }
      yield* build(task, { tank, onSourceError }, worktreeCtx)
      expect(reported).toEqual(["rules"])
    }),
  )

  it.effect("an interruption of a source is not swallowed", () =>
    Effect.gen(function* () {
      const interrupting: BriefingMemory = { search: () => Effect.interrupt }
      const exit = yield* Effect.exit(build(withSpec({ kind: "routine" }), { memory: interrupting }))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    }),
  )
})
