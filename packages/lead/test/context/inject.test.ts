import { existsSync } from "node:fs"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { ExecutorId, type ExecutorTask } from "@shoalwork/contracts"
import type { TankContext } from "@shoalwork/tank"
import { Effect, Schema } from "effect"
import { describe, expect } from "vitest"
import type { BriefingMemory } from "../../src/context/briefing.js"
import { makeInjector } from "../../src/context/inject.js"
import { makeFakeTank } from "../support.js"
import { bot, localTank, orDie, prepareWorktree, removeDir, scratchRepo, spec } from "./fixtures.js"

const CLAUDE = Schema.decodeUnknownSync(ExecutorId)("claude-code")
const CODEX = Schema.decodeUnknownSync(ExecutorId)("codex")

const task: ExecutorTask = {
  taskId: spec.id,
  botId: bot.id,
  prompt: "Implement the feature.",
  tier: "light",
  allowedTools: [],
  permissionMode: "edit",
  maxTurns: 50,
  budget: spec.budget,
}

const memory: BriefingMemory = {
  search: () =>
    Effect.succeed([
      {
        id: "mem_1",
        scope: "bot",
        owner_id: bot.id,
        kind: "semantic",
        content: "The sandbox repo is private.",
        source: "user:renan",
        confidence: 1,
        created_at: "2026-10-20T00:00:00.000Z",
        superseded_by: null,
        tombstone: 0,
        score: 1,
      },
    ]),
}

const scratchCtx: TankContext = {
  botId: bot.id,
  botName: bot.name,
  cwd: "/work/scratch",
  home: "/work/home",
  env: {},
}

describe("makeInjector", () => {
  it.effect("without a worktree, claude-code gets the briefing as its system prompt", () =>
    Effect.gen(function* () {
      const inject = makeInjector({ tank: makeFakeTank().shape, memory, raiseError: () => Effect.void })
      const delivered = yield* Effect.scoped(inject(scratchCtx, { spec, bot, task, executor: CLAUDE }))
      expect(delivered.prompt).toBe("Implement the feature.")
      expect(delivered.systemAppend).toContain("# Project memory")
      expect(delivered.systemAppend).toContain("The sandbox repo is private.")
    }),
  )

  it.effect("without a worktree, codex gets the briefing at the head of the prompt", () =>
    Effect.gen(function* () {
      const inject = makeInjector({ tank: makeFakeTank().shape, memory, raiseError: () => Effect.void })
      const delivered = yield* Effect.scoped(inject(scratchCtx, { spec, bot, task, executor: CODEX }))
      expect(delivered.systemAppend).toBeUndefined()
      expect(delivered.prompt.startsWith("# Role\n")).toBe(true)
      expect(delivered.prompt.endsWith("\n\nImplement the feature.")).toBe(true)
    }),
  )

  it.effect("in a worktree the files carry the briefing and are gone when the scope closes", () => {
    const { dir, origin } = scratchRepo({})
    return Effect.gen(function* () {
      const tank = localTank(dir)
      const ctx = yield* orDie(prepareWorktree(tank, origin))
      const inject = makeInjector({ tank, memory, raiseError: () => Effect.void })
      const delivered = yield* Effect.scoped(
        Effect.gen(function* () {
          const result = yield* inject(ctx, { spec, bot, task, executor: CLAUDE })
          expect(existsSync(join(ctx.cwd, "AGENTS.md"))).toBe(true)
          return result
        }),
      )
      expect(delivered).toEqual(task)
      expect(existsSync(join(ctx.cwd, "AGENTS.md"))).toBe(false)
      expect(existsSync(join(ctx.cwd, "CLAUDE.md"))).toBe(false)
    }).pipe(Effect.ensuring(Effect.sync(() => removeDir(dir))))
  })

  it.effect("a repo with its own instructions gets the briefing through the system prompt", () => {
    const { dir, origin } = scratchRepo({ "CLAUDE.md": "repo\n" })
    return Effect.gen(function* () {
      const tank = localTank(dir)
      const ctx = yield* orDie(prepareWorktree(tank, origin))
      const inject = makeInjector({ tank, memory, raiseError: () => Effect.void })
      const delivered = yield* Effect.scoped(inject(ctx, { spec, bot, task, executor: CLAUDE }))
      expect(delivered.systemAppend).toContain("# Current task")
      expect(existsSync(join(ctx.cwd, "AGENTS.generated.md"))).toBe(false)
    }).pipe(Effect.ensuring(Effect.sync(() => removeDir(dir))))
  })

  it.effect("a failing write is reported and the briefing still reaches the executor", () => {
    const reported: Array<string> = []
    const worktreeCtx: TankContext = {
      ...scratchCtx,
      worktree: { path: "/work/scratch", branch: "bot/dev-demo/step", repoDir: "/work/repo" },
    }
    const inject = makeInjector({
      tank: makeFakeTank().shape,
      memory,
      raiseError: (_spec, where) =>
        Effect.sync(() => {
          reported.push(where)
        }),
    })
    return Effect.gen(function* () {
      const delivered = yield* Effect.scoped(inject(worktreeCtx, { spec, bot, task, executor: CLAUDE }))
      expect(reported).toEqual(["lead.context"])
      expect(delivered.systemAppend).toContain("# Role")
    })
  })
})
