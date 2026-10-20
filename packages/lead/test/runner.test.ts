import { it } from "@effect/vitest"
import { BotRegistry } from "@shoalwork/bots"
import { ExecutorProtocolError, ExecutorSpawnError, TaskId, type Verdict } from "@shoalwork/contracts"
import { Deferred, Duration, Effect, Fiber, Schema, Stream } from "effect"
import { describe, expect } from "vitest"
import { stepIdFor } from "../src/verdict.js"
import {
  allEvents,
  createBot,
  eventsOf,
  eventTypes,
  failFinalWrites,
  fakeExecutor,
  Lead,
  leadLayer,
  makeFakeTank,
  OK_EVENTS,
  type Runs,
  SESSION,
  specFor,
} from "./support.js"

const UNKNOWN_TASK = Schema.decodeUnknownSync(TaskId)("task_00000000-0000-4000-8000-000000000000")

describe("Lead.runOnce", () => {
  it.effect("an ok run emits the exact event sequence and returns an ok verdict", () => {
    const runs: Runs = []
    const tank = makeFakeTank()
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot))
      const verdict = yield* lead.runOnce(spec.id)

      expect(verdict).toMatchObject({
        kind: "ok",
        summary: "all good",
        evidence: [],
        sessionId: SESSION,
        cost: { tokensIn: 100, tokensOut: 50, usd: 0.25 },
      })
      expect(yield* eventTypes).toEqual([
        "bot.created",
        "task.received",
        "task.state_changed",
        "bot.state_changed",
        "executor.started",
        "executor.event", // started
        "executor.event", // text
        "executor.event", // usage
        "usage.recorded",
        "executor.event", // done
        "executor.finished",
        "task.state_changed",
        "bot.state_changed",
      ])

      const events = yield* allEvents
      const transitions = events
        .filter((event) => event.type === "task.state_changed" || event.type === "bot.state_changed")
        .map((event) => {
          const payload = event.payload as { readonly from: string; readonly to: string }
          return `${payload.from}>${payload.to}`
        })
      expect(transitions).toEqual(["received>running", "idle>working", "running>done", "working>idle"])

      const started = events.find((event) => event.type === "executor.started")
      expect(started?.payload).toMatchObject({
        botId: bot.id,
        executor: "claude-code",
        model: "claude-haiku-5-5", // effective model from the tier table (light)
        cwd: "/work/cwd",
      })

      const stored = yield* lead.get(spec.id)
      expect(stored.state).toBe("done")
      expect(stored.verdict).toEqual(verdict)
      expect((yield* (yield* BotRegistry).list())[0]?.state).toBe("idle")

      // The executor got an edit-mode task with the acceptance criteria appended, and the tank was kept clean.
      expect(runs).toHaveLength(1)
      expect(runs[0]).toMatchObject({
        taskId: spec.id,
        botId: bot.id,
        permissionMode: "edit",
        maxTurns: 50,
        allowedTools: [],
        tier: "light",
        prompt: "Implement the feature.\n\nAcceptance:\n- tests pass",
      })
      expect(tank.released).toEqual([{ keepWorktree: false }])
    }).pipe(Effect.provide(leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS), runs), tank })))
  })

  it.effect("an executor error with max_turns becomes a failed verdict and keeps the worktree", () => {
    const tank = makeFakeTank()
    const events = [
      { kind: "started" as const },
      { kind: "error" as const, code: "max_turns" as const, message: "reached the turn limit" },
    ]
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot))
      const verdict = yield* lead.runOnce(spec.id)
      expect(verdict).toMatchObject({ kind: "failed", summary: "reached the turn limit" })
      expect((yield* lead.get(spec.id)).state).toBe("failed")
      expect(tank.released).toEqual([{ keepWorktree: true }])
    }).pipe(Effect.provide(leadLayer({ executor: fakeExecutor(eventsOf(events)), tank })))
  })

  it.effect("an executor error with code budget becomes budget_exceeded and records budget.exceeded", () =>
    Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot))
      const verdict = yield* lead.runOnce(spec.id)
      expect(verdict.kind).toBe("budget_exceeded")
      expect((yield* eventTypes).filter((type) => type === "budget.exceeded")).toHaveLength(1)
      expect((yield* lead.get(spec.id)).state).toBe("failed")
    }).pipe(
      Effect.provide(
        leadLayer({
          executor: fakeExecutor(
            eventsOf([{ kind: "error", code: "budget", message: "cost limit reached" }]),
          ),
        }),
      ),
    ),
  )

  it.effect("a defect inside the executor becomes a blocked verdict and an error.raised event", () => {
    const tank = makeFakeTank()
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot))
      const verdict = yield* lead.runOnce(spec.id)
      expect(verdict.kind).toBe("blocked")
      expect(verdict.summary).toContain("kaboom")

      const raised = (yield* allEvents).filter((event) => event.type === "error.raised")
      expect(raised).toHaveLength(1)
      expect(raised[0]?.payload).toMatchObject({ where: "lead.runOnce", taskId: spec.id, botId: bot.id })
      expect((yield* lead.get(spec.id)).state).toBe("failed")
      expect((yield* (yield* BotRegistry).list())[0]?.state).toBe("idle")
      expect(tank.released).toEqual([{ keepWorktree: true }])
    }).pipe(
      Effect.provide(leadLayer({ executor: fakeExecutor(() => Stream.die(new Error("kaboom"))), tank })),
    )
  })

  it.effect("a stream that ends without a terminal event becomes a blocked verdict", () =>
    Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot))
      const verdict = yield* lead.runOnce(spec.id)
      expect(verdict).toMatchObject({
        kind: "blocked",
        summary: "executor stream ended without a terminal event",
        evidence: ["protocol"],
      })
    }).pipe(
      Effect.provide(
        leadLayer({
          executor: fakeExecutor(eventsOf([{ kind: "text", text: "hm" }])),
          guarded: false,
        }),
      ),
    ),
  )

  it.effect("the registry's synthetic protocol error is blocked, not failed", () =>
    Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot))
      const verdict = yield* lead.runOnce(spec.id)
      expect(verdict.kind).toBe("blocked")
      expect(verdict.summary).toContain("without a terminal event")
    }).pipe(Effect.provide(leadLayer({ executor: fakeExecutor(eventsOf([{ kind: "text", text: "hm" }])) }))),
  )

  it.effect("typed adapter errors in the stream channel become blocked verdicts", () => {
    let calls = 0
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const spawn = yield* lead.intake(specFor(bot))
      const protocol = yield* lead.intake(specFor(bot))
      const spawnVerdict = yield* lead.runOnce(spawn.id)
      const protocolVerdict = yield* lead.runOnce(protocol.id)
      expect(spawnVerdict).toMatchObject({ kind: "blocked", evidence: ["ExecutorSpawnError"] })
      expect(protocolVerdict).toMatchObject({ kind: "blocked", evidence: ["ExecutorProtocolError"] })
      // The raw CLI line and the spawn cause never reach the verdict or the events.
      const text = JSON.stringify([spawnVerdict, protocolVerdict, yield* allEvents])
      expect(text).not.toContain("SECRET-LINE")
      expect(text).not.toContain("SECRET-CAUSE")
      expect((yield* allEvents).filter((event) => event.type === "error.raised")).toHaveLength(2)
    }).pipe(
      Effect.provide(
        leadLayer({
          executor: fakeExecutor((_task) => {
            calls += 1
            return calls === 1
              ? Stream.fail(new ExecutorSpawnError({ executor: "claude-code", cause: "SECRET-CAUSE" }))
              : Stream.fail(
                  new ExecutorProtocolError({ executor: "claude-code", line: "SECRET-LINE", cause: 1 }),
                )
          }),
        }),
      ),
    )
  })

  it.effect("approval_needed stops the stream and yields needs_approval", () => {
    const tank = makeFakeTank()
    const events = [
      { kind: "started" as const },
      {
        kind: "approval_needed" as const,
        action: { tool: "Bash", input: { cmd: "rm -rf build" }, resource: "build/" },
        risk: "irreversible" as const,
      },
      { kind: "text" as const, text: "must not be recorded" },
      { kind: "done" as const, result: "must not be recorded", artifacts: [] },
    ]
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot))
      const verdict = yield* lead.runOnce(spec.id)
      expect(verdict).toMatchObject({ kind: "needs_approval", evidence: ["build/"] })
      expect(verdict.summary).toContain("Bash")
      expect((yield* lead.get(spec.id)).state).toBe("waiting_approval")
      const recorded = (yield* allEvents)
        .filter((event) => event.type === "executor.event")
        .map((event) => (event.payload as { readonly event: { readonly kind: string } }).event.kind)
      expect(recorded).toEqual(["started", "approval_needed"])
      expect(tank.released).toEqual([{ keepWorktree: true }])
    }).pipe(Effect.provide(leadLayer({ executor: fakeExecutor(eventsOf(events)), tank })))
  })

  it.live("exceeding the time budget interrupts the run and yields budget_exceeded", () => {
    const tank = makeFakeTank()
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot, { budget: { tokens: 1000, seconds: 1, usd: 1 } }))
      const verdict = yield* lead.runOnce(spec.id)
      expect(verdict).toMatchObject({ kind: "budget_exceeded", summary: "task exceeded its time budget" })
      expect((yield* lead.get(spec.id)).state).toBe("failed")
      expect(tank.released).toEqual([{ keepWorktree: true }])
      expect((yield* eventTypes).filter((type) => type === "budget.exceeded")).toHaveLength(1)
    }).pipe(Effect.provide(leadLayer({ executor: fakeExecutor(() => Stream.never), tank })))
  })

  it.effect("a tank that cannot prepare yields blocked and nothing to release", () => {
    const tank = makeFakeTank({ failPrepare: true })
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot))
      const verdict = yield* lead.runOnce(spec.id)
      expect(verdict).toMatchObject({ kind: "blocked", evidence: ["TankError"] })
      expect(verdict.summary).toContain("prepare")
      expect(tank.released).toEqual([])
      expect((yield* lead.get(spec.id)).state).toBe("failed")
    }).pipe(Effect.provide(leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS)), tank })))
  })

  it.effect("running an already settled task returns the stored verdict without running again", () => {
    const runs: Runs = []
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot))
      const first = yield* lead.runOnce(spec.id)
      const second = yield* lead.runOnce(spec.id)
      expect(second).toEqual(first)
      expect(runs).toHaveLength(1)
    }).pipe(Effect.provide(leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS), runs) })))
  })

  it.effect("an unknown task id returns a blocked verdict instead of failing", () =>
    Effect.gen(function* () {
      const lead = yield* Lead
      const verdict: Verdict = yield* lead.runOnce(UNKNOWN_TASK)
      expect(verdict.kind).toBe("blocked")
      expect(verdict.summary).toContain("NotFound")
    }).pipe(Effect.provide(leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS)) }))),
  )

  it.effect("truncates a long result to 2000 characters", () =>
    Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot))
      const verdict = yield* lead.runOnce(spec.id)
      expect(verdict.kind).toBe("ok")
      expect(verdict.summary).toHaveLength(2000)
    }).pipe(
      Effect.provide(
        leadLayer({
          executor: fakeExecutor(eventsOf([{ kind: "done", result: "x".repeat(5000), artifacts: [] }])),
        }),
      ),
    ),
  )

  it.live(
    "a re-run after an interrupted attempt gets a new step id, so the kept worktree does not collide",
    () => {
      const tank = makeFakeTank()
      let calls = 0
      const executor = fakeExecutor(() => {
        calls += 1
        return calls === 1 ? Stream.never : Stream.fromIterable(OK_EVENTS)
      })
      return Effect.gen(function* () {
        const lead = yield* Lead
        const bot = yield* createBot
        const spec = yield* lead.intake(
          specFor(bot, { repo: { url: "https://example.com/r.git", base: "main" } }),
        )
        const first = yield* Effect.forkChild(lead.runOnce(spec.id))
        while (tank.prepared.length < 1) {
          yield* Effect.sleep(Duration.millis(5))
        }
        // The first attempt dies mid-run (lost lock, shutdown): its worktree is kept for diagnosis.
        yield* Fiber.interrupt(first)
        expect(tank.released).toEqual([{ keepWorktree: true }])
        expect((yield* lead.get(spec.id)).state).toBe("running")

        const verdict = yield* lead.runOnce(spec.id)
        expect(verdict.kind).toBe("ok")
        expect(tank.prepared).toHaveLength(2)
        expect(new Set(tank.prepared).size).toBe(2)
      }).pipe(Effect.provide(leadLayer({ executor, tank })))
    },
  )

  it.effect("stepIdFor is stable per attempt, differs between attempts and matches the StepId shape", () =>
    Effect.sync(() => {
      expect(stepIdFor(UNKNOWN_TASK, 1)).toBe(stepIdFor(UNKNOWN_TASK, 1))
      expect(stepIdFor(UNKNOWN_TASK, 1)).not.toBe(stepIdFor(UNKNOWN_TASK, 2))
      expect(stepIdFor(UNKNOWN_TASK, 1)).toMatch(/^step_[0-9a-f-]{36}$/)
    }),
  )

  it.live("the time budget also covers a prepare that hangs", () => {
    const tank = makeFakeTank({ hangPrepare: true })
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot, { budget: { tokens: 1000, seconds: 1, usd: 1 } }))
      const verdict = yield* lead.runOnce(spec.id)
      expect(verdict.kind).toBe("budget_exceeded")
      expect((yield* lead.get(spec.id)).state).toBe("failed")
      expect(tank.released).toEqual([])
    }).pipe(Effect.provide(leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS)), tank })))
  })

  it.effect("a failure while recording the verdict is reported and the verdict is still returned", () =>
    Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot))
      const verdict = yield* lead.runOnce(spec.id)
      expect(verdict.kind).toBe("ok")
      const raised = (yield* allEvents).filter((event) => event.type === "error.raised")
      expect(raised.map((event) => event.payload)).toMatchObject([{ where: "lead.finish" }])
      expect((yield* lead.get(spec.id)).state).toBe("running")
    }).pipe(
      Effect.provide(leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS)), wrapStore: failFinalWrites })),
    ),
  )

  it.live("the bot stays working while another of its tasks is still running", () => {
    const release = Deferred.makeUnsafe<void>()
    const executor = fakeExecutor((task) =>
      task.prompt.startsWith("slow")
        ? Stream.fromEffect(
            Deferred.await(release).pipe(
              Effect.as({ kind: "done" as const, result: "slow done", artifacts: [] }),
            ),
          )
        : Stream.fromIterable(OK_EVENTS),
    )
    const botState = Effect.gen(function* () {
      const registry = yield* BotRegistry
      return (yield* registry.list())[0]?.state
    })
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const slow = yield* lead.intake(specFor(bot, { prompt: "slow task" }))
      const fast = yield* lead.intake(specFor(bot, { prompt: "fast task" }))
      const slowFiber = yield* Effect.forkChild(lead.runOnce(slow.id))
      while ((yield* lead.get(slow.id)).state !== "running") {
        yield* Effect.sleep(Duration.millis(5))
      }
      expect((yield* lead.runOnce(fast.id)).kind).toBe("ok")
      expect(yield* botState).toBe("working")

      yield* Deferred.succeed(release, undefined)
      expect((yield* Fiber.join(slowFiber)).kind).toBe("ok")
      expect(yield* botState).toBe("idle")

      const changes = (yield* allEvents)
        .filter((event) => event.type === "bot.state_changed")
        .map((event) => (event.payload as { readonly to: string }).to)
      expect(changes).toEqual(["working", "idle"])
    }).pipe(Effect.provide(leadLayer({ executor })))
  })
})
