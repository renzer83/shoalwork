import { it } from "@effect/vitest"
import { BotRegistry } from "@shoalwork/bots"
import {
  type Bot,
  type ExecutorEvent,
  newTaskId,
  type StepId,
  TankError,
  type TaskSpec,
} from "@shoalwork/contracts"
import { Effect, Stream } from "effect"
import { describe, expect } from "vitest"
import { Lead, TaskStore } from "../src/index.js"
import type { TaskPatch, TaskStoreShape } from "../src/tasks.js"
import { stepIdFor } from "../src/verdict.js"
import {
  createBot,
  eventTypes,
  fakeExecutor,
  leadLayer,
  makeFakeTank,
  NEW_BOT,
  OK_EVENTS,
  type Runs,
  SESSION,
  specFor,
} from "./support.js"

const REPO = { url: "https://github.com/renzer83/shoalwork-sandbox", base: "main" }

// The parent run: it reports its session, says where it stopped, and fails for a reason a retry cannot fix.
const PARENT_EVENTS: ReadonlyArray<ExecutorEvent> = [
  { kind: "started", sessionId: SESSION },
  { kind: "text", text: "step one done" },
  { kind: "error", code: "auth", message: "token expired" },
]

// Each run asks for its events by its number (1 = the first run); `runs` records every run's task.
const scripted = (runs: Runs, script: (run: number) => ReadonlyArray<ExecutorEvent>) =>
  fakeExecutor(() => Stream.fromIterable(script(runs.length)), runs)

// A Tank whose prepare calls are recorded (step and whether they reuse a worktree), that keeps the worktree of `kept`
// for the Bot, and that can refuse every reuse.
const recordingTank = (opts: { readonly failReuse?: boolean } = {}) => {
  const tank = makeFakeTank()
  const prepares: Array<{ readonly stepId: StepId; readonly reused: boolean }> = []
  let kept: StepId | undefined
  const base = tank.shape
  const shape = {
    ...base,
    prepare: (bot: Bot, step: Parameters<typeof base.prepare>[1]) => {
      if (step.reuse !== undefined && opts.failReuse === true) {
        return Effect.fail(new TankError({ op: "prepare", cause: "worktree locked" }))
      }
      prepares.push({ stepId: step.stepId, reused: step.reuse !== undefined })
      return base.prepare(bot, step)
    },
    worktrees: (bot: Bot) =>
      Effect.succeed(
        kept === undefined
          ? []
          : [{ repoDir: "/work/repo", path: "/work/wt", branch: `bot/${bot.name}/${kept}` }],
      ),
  }
  return {
    tank: { ...tank, shape },
    prepares,
    keep: (step: StepId) => {
      kept = step
    },
  }
}

describe("continuing a task (resumeOf)", () => {
  it.effect(
    "resumes the parent's session in the parent's worktree, with the parent's last words in the prompt",
    () => {
      const runs: Runs = []
      const rec = recordingTank()
      return Effect.gen(function* () {
        const lead = yield* Lead
        const bot = yield* createBot
        const parent = yield* lead.intake(
          specFor(bot, { repo: REPO, title: "Refactor the parser", prompt: "Refactor the parser module." }),
        )
        const parentStep = stepIdFor(parent.id, 1)
        expect(yield* lead.runOnce(parent.id)).toMatchObject({ kind: "blocked" })
        rec.keep(parentStep)

        const child = yield* lead.intake({
          ...specFor(bot, { repo: REPO, title: parent.title, prompt: parent.prompt }),
          resumeOf: parent.id,
        })
        expect(yield* lead.runOnce(child.id)).toMatchObject({ kind: "ok" })

        const resumed = runs[1]
        expect(resumed?.resumeSessionId).toBe(SESSION)
        expect(resumed?.prompt).toContain("step one done")
        // The reuse is the parent's step: the continuation ran in the worktree the parent left.
        expect(rec.prepares).toContainEqual({ stepId: parentStep, reused: true })
        const stored = yield* (yield* TaskStore).get(child.id)
        expect(stored.spec.resumeOf).toBe(parent.id)
        expect(stored.state).toBe("done")
      }).pipe(
        Effect.provide(
          leadLayer({
            executor: scripted(runs, (run) => (run === 1 ? PARENT_EVENTS : OK_EVENTS)),
            tank: rec.tank,
          }),
        ),
      )
    },
  )

  it.effect(
    "a chain of three resumes the same worktree and session: the grandchild continues the step the child used",
    () => {
      const runs: Runs = []
      const rec = recordingTank()
      return Effect.gen(function* () {
        const lead = yield* Lead
        const bot = yield* createBot
        const parent = yield* lead.intake(specFor(bot, { repo: REPO, title: "Refactor the parser" }))
        const parentStep = stepIdFor(parent.id, 1)
        expect(yield* lead.runOnce(parent.id)).toMatchObject({ kind: "blocked" })
        rec.keep(parentStep)

        // The child fails again in the same worktree: it ran the parent's step.
        const child = yield* lead.intake({
          ...specFor(bot, { repo: REPO, title: "Refactor the parser" }),
          resumeOf: parent.id,
        })
        expect(yield* lead.runOnce(child.id)).toMatchObject({ kind: "blocked" })
        expect(runs[1]?.resumeSessionId).toBe(SESSION)

        const grandchild = yield* lead.intake({
          ...specFor(bot, { repo: REPO, title: "Refactor the parser" }),
          resumeOf: child.id,
        })
        expect(yield* lead.runOnce(grandchild.id)).toMatchObject({ kind: "ok" })
        expect(runs[2]?.resumeSessionId).toBe(SESSION)
        expect(rec.prepares).toContainEqual({ stepId: parentStep, reused: true })
        expect(rec.prepares.filter((p) => p.reused).every((p) => p.stepId === parentStep)).toBe(true)
      }).pipe(
        Effect.provide(
          leadLayer({
            executor: scripted(runs, (run) => (run < 3 ? PARENT_EVENTS : OK_EVENTS)),
            tank: rec.tank,
          }),
        ),
      )
    },
  )

  it.effect(
    "when the worktree is gone the continuation runs fresh, with the parent's events in its briefing",
    () => {
      const runs: Runs = []
      const tank = makeFakeTank()
      return Effect.gen(function* () {
        const lead = yield* Lead
        const bot = yield* createBot
        const parent = yield* lead.intake(specFor(bot, { repo: REPO, title: "Refactor the parser" }))
        expect(yield* lead.runOnce(parent.id)).toMatchObject({ kind: "blocked" })

        const child = yield* lead.intake({
          ...specFor(bot, { repo: REPO, title: "Refactor the parser" }),
          resumeOf: parent.id,
        })
        expect(yield* lead.runOnce(child.id)).toMatchObject({ kind: "ok" })

        const fresh = runs[1]
        expect(fresh?.resumeSessionId).toBeUndefined()
        expect(fresh?.prompt).toContain("step one done")
        expect(fresh?.systemAppend).toContain("Recent events of this task")
        expect(fresh?.systemAppend).toContain("step one done")
      }).pipe(
        Effect.provide(
          leadLayer({ executor: scripted(runs, (run) => (run === 1 ? PARENT_EVENTS : OK_EVENTS)), tank }),
        ),
      )
    },
  )

  it.effect("a failed reuse of the worktree is reported and keeps the parent's events", () => {
    const runs: Runs = []
    const rec = recordingTank({ failReuse: true })
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const parent = yield* lead.intake(specFor(bot, { repo: REPO, title: "Refactor the parser" }))
      expect(yield* lead.runOnce(parent.id)).toMatchObject({ kind: "blocked" })
      rec.keep(stepIdFor(parent.id, 1))

      const child = yield* lead.intake({
        ...specFor(bot, { repo: REPO, title: "Refactor the parser" }),
        resumeOf: parent.id,
      })
      expect(yield* lead.runOnce(child.id)).toMatchObject({ kind: "ok" })

      const run = runs[1]
      expect(run?.resumeSessionId).toBeUndefined()
      expect(run?.systemAppend).toContain("step one done")
      expect(run?.prompt).toContain("step one done")
      expect(yield* eventTypes).toContain("error.raised")
    }).pipe(
      Effect.provide(
        leadLayer({
          executor: scripted(runs, (run) => (run === 1 ? PARENT_EVENTS : OK_EVENTS)),
          tank: rec.tank,
        }),
      ),
    )
  })

  it.effect("when the briefing cannot hold every line, the newest ones are the ones kept", () => {
    const runs: Runs = []
    const tank = makeFakeTank()
    const many: ReadonlyArray<ExecutorEvent> = [
      { kind: "started", sessionId: SESSION },
      ...Array.from({ length: 30 }, (_, index) => ({
        kind: "text" as const,
        text: `step-${String(index + 1).padStart(2, "0")} ${"work ".repeat(30)}`,
      })),
      { kind: "error", code: "auth", message: "token expired" },
    ]
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const parent = yield* lead.intake(specFor(bot, { title: "Long run" }))
      expect(yield* lead.runOnce(parent.id)).toMatchObject({ kind: "blocked" })

      const child = yield* lead.intake({ ...specFor(bot, { title: "Long run" }), resumeOf: parent.id })
      expect(yield* lead.runOnce(child.id)).toMatchObject({ kind: "ok" })

      const briefing = runs[1]?.systemAppend ?? ""
      expect(briefing).toContain("step-30")
      expect(briefing).not.toContain("step-01")
    }).pipe(
      Effect.provide(leadLayer({ executor: scripted(runs, (run) => (run === 1 ? many : OK_EVENTS)), tank })),
    )
  })

  it.effect("a secret in the parent's last words reaches the briefing and the prompt redacted", () => {
    const runs: Runs = []
    const tank = makeFakeTank()
    const leaky: ReadonlyArray<ExecutorEvent> = [
      { kind: "started", sessionId: SESSION },
      { kind: "text", text: "step one done" },
      { kind: "text", text: "token: abc123secretvalue" },
      { kind: "error", code: "auth", message: "token expired" },
    ]
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const parent = yield* lead.intake(specFor(bot, { title: "Leaky run" }))
      expect(yield* lead.runOnce(parent.id)).toMatchObject({ kind: "blocked" })

      const child = yield* lead.intake({ ...specFor(bot, { title: "Leaky run" }), resumeOf: parent.id })
      expect(yield* lead.runOnce(child.id)).toMatchObject({ kind: "ok" })

      const run = runs[1]
      expect(run?.prompt).toContain("[redacted]")
      expect(run?.prompt).not.toContain("abc123secretvalue")
      expect(run?.systemAppend).toContain("[redacted]")
      expect(run?.systemAppend).not.toContain("abc123secretvalue")
    }).pipe(
      Effect.provide(leadLayer({ executor: scripted(runs, (run) => (run === 1 ? leaky : OK_EVENTS)), tank })),
    )
  })

  it.effect(
    "the intake refuses a parent of another Bot, an unknown one, an unfinished one and a second continuation",
    () => {
      const runs: Runs = []
      return Effect.gen(function* () {
        const lead = yield* Lead
        const bot = yield* createBot
        const registry = yield* BotRegistry
        const other = yield* registry.upsert({ ...NEW_BOT, name: "other-bot" }, "test")
        const foreign = yield* lead.intake(specFor(other, { title: "Foreign" }))
        const unfinished = yield* lead.intake(specFor(bot, { title: "Unfinished" }))
        const parent = yield* lead.intake(specFor(bot, { title: "Parent" }))
        expect(yield* lead.runOnce(parent.id)).toMatchObject({ kind: "blocked" })

        const foreignRefusal = yield* lead
          .intake({ ...specFor(bot, { title: "Hijack" }), resumeOf: foreign.id })
          .pipe(Effect.flip)
        expect(foreignRefusal).toMatchObject({ _tag: "NotFound", entity: "Task" })

        const unknownRefusal = yield* lead
          .intake({ ...specFor(bot, { title: "Ghost" }), resumeOf: newTaskId() })
          .pipe(Effect.flip)
        expect(unknownRefusal).toMatchObject({ _tag: "NotFound" })

        const unfinishedRefusal = yield* lead
          .intake({ ...specFor(bot, { title: "Early" }), resumeOf: unfinished.id })
          .pipe(Effect.flip)
        expect(unfinishedRefusal).toMatchObject({
          _tag: "SchemaViolation",
          issue: { reason: "not-finished" },
        })

        const first = yield* lead.intake({ ...specFor(bot, { title: "Parent" }), resumeOf: parent.id })
        const second = yield* lead
          .intake({ ...specFor(bot, { title: "Parent again" }), resumeOf: parent.id })
          .pipe(Effect.flip)
        expect(second).toMatchObject({
          _tag: "SchemaViolation",
          issue: { reason: "already-continued", running: first.id },
        })
      }).pipe(Effect.provide(leadLayer({ executor: scripted(runs, () => PARENT_EVENTS) })))
    },
  )

  it.effect(
    "a continuation stored behind the intake's back is refused when it runs, and runs without a carry",
    () => {
      const runs: Runs = []
      return Effect.gen(function* () {
        const lead = yield* Lead
        const store = yield* TaskStore
        const bot = yield* createBot
        const registry = yield* BotRegistry
        const other = yield* registry.upsert({ ...NEW_BOT, name: "other-bot" }, "test")
        const foreign = yield* lead.intake(specFor(other, { title: "Foreign" }))
        const child: TaskSpec = {
          ...specFor(bot, { title: "Smuggled" }),
          id: newTaskId(),
          resumeOf: foreign.id,
        }
        yield* store.insert(child)

        yield* lead.runOnce(child.id)
        expect(runs[0]?.resumeSessionId).toBeUndefined()
        expect(runs[0]?.prompt).not.toContain("step one done")
        expect(yield* eventTypes).toContain("error.raised")
      }).pipe(Effect.provide(leadLayer({ executor: scripted(runs, () => OK_EVENTS) })))
    },
  )

  it.effect("the session is written down on the first event that reports it, before the run ends", () => {
    const patches: Array<TaskPatch> = []
    const recording = (real: TaskStoreShape): TaskStoreShape => ({
      ...real,
      update: (id, patch) => {
        patches.push(patch)
        return real.update(id, patch)
      },
    })
    const runs: Runs = []
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const parent = yield* lead.intake(specFor(bot, { repo: REPO }))
      expect(yield* lead.runOnce(parent.id)).toMatchObject({ kind: "blocked" })

      const sessionOnly = patches.findIndex(
        (patch) => patch.sessionId === SESSION && patch.state === undefined,
      )
      const failed = patches.findIndex((patch) => patch.state === "failed")
      expect(sessionOnly).toBeGreaterThanOrEqual(0)
      expect(sessionOnly).toBeLessThan(failed)
    }).pipe(
      Effect.provide(leadLayer({ executor: scripted(runs, () => PARENT_EVENTS), wrapStore: recording })),
    )
  })
})
