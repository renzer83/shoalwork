import { it } from "@effect/vitest"
import { type ExecutorEvent, NotFound, SchemaViolation, type TaskId } from "@shoalwork/contracts"
import { Effect, Stream } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import {
  createTwoExecutorsBot,
  edit,
  Lead,
  OTHER_SHA,
  replay,
  replayRows,
  SHA,
  streamEvents,
} from "./replay-support.js"
import {
  CODEX,
  createBot,
  eventsOf,
  fakeExecutor,
  HEALTHY_EXEC,
  leadLayer,
  makeFakeTank,
  OK_EVENTS,
  type Runs,
  SESSION,
  specFor,
  USAGE_EVENT,
} from "./support.js"

const REPO = { url: "https://github.com/renzer83/shoalwork-sandbox", base: "main" } as const

const exitZero = (stdout: string) => ({ exitCode: 0, stdout, stderr: "", durationMs: 1, timedOut: false })

// A Tank whose HEAD is `head.sha`: the probe at the start of a run records it as the base.
const tankAt = (head: { sha: string }) =>
  makeFakeTank({
    exec: (argv) =>
      argv.join(" ") === "git rev-parse HEAD" ? exitZero(`${head.sha}\n`) : HEALTHY_EXEC(argv),
  })

const executorEvents = (...extra: ReadonlyArray<ExecutorEvent>): ReadonlyArray<ExecutorEvent> => [
  { kind: "started", sessionId: SESSION },
  ...extra,
  USAGE_EVENT,
  { kind: "done", result: "all good", artifacts: [] },
]

const snapshotText = (taskId: TaskId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const rows = yield* sql<{
      readonly text: string
    }>`SELECT text FROM context_snapshots WHERE task_id = ${taskId}`
    return rows[0]?.text
  })

describe("Replay.run", () => {
  it.effect("creates a NEW task from the log, linked to the source, and leaves the source untouched", () => {
    const head = { sha: SHA }
    const runs: Runs = []
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const source = yield* lead.intake(specFor(bot, { repo: REPO, title: "Fix the parser" }))
      yield* lead.runOnce(source.id)
      const before = yield* streamEvents(source.id)
      const record = yield* lead.get(source.id)
      expect(before.find((event) => event.type === "executor.started")?.payload).toMatchObject({
        baseSha: SHA,
      })
      expect(yield* snapshotText(source.id)).toContain("# Current task")

      const started = yield* (yield* replay).run(source.id)

      expect(started.task.id).not.toBe(source.id)
      expect(started.task).toMatchObject({
        botId: bot.id,
        title: "Replay: Fix the parser",
        prompt: source.prompt,
        acceptance: source.acceptance,
        budget: source.budget,
        repo: REPO,
        origin: "api",
        tier: source.tier,
      })
      expect(started.task.parent).toBeUndefined()
      expect(started.baseSha).toBe(SHA)
      expect(started.contextFrozen).toBe(true)
      const [row] = yield* replayRows
      expect(row).toMatchObject({
        id: started.replayId,
        source_task_id: source.id,
        new_task_id: started.task.id,
        base_sha: SHA,
        context_frozen: 1,
      })
      // R12: the link is an event on the new task's stream, under the original's correlation.
      const created = (yield* streamEvents(started.task.id)).find((event) => event.type === "replay.created")
      expect(created?.correlationId).toBe(source.id)
      expect(created?.payload).toMatchObject({ replayOf: source.id, taskId: started.task.id, baseSha: SHA })
      // The source: same record, same log.
      expect(yield* lead.get(source.id)).toEqual(record)
      expect(yield* streamEvents(source.id)).toEqual(before)
      expect(runs).toHaveLength(1)
    }).pipe(
      Effect.provide(
        leadLayer({
          executor: fakeExecutor(eventsOf(OK_EVENTS), runs),
          tank: tankAt(head),
          liveBeacon: true,
        }),
      ),
    )
  })

  it.effect(
    "rebuilds the same ExecutorTask: frozen context text, the commit of the source, and no delivery",
    () => {
      const head = { sha: SHA }
      const runs: Runs = []
      const tank = tankAt(head)
      return Effect.gen(function* () {
        const lead = yield* Lead
        const bot = yield* createBot
        const source = yield* lead.intake(specFor(bot, { repo: REPO }))
        yield* lead.runOnce(source.id)
        const prCommands = () => tank.commands.filter((argv) => argv[1] === "add").length
        expect(prCommands()).toBeGreaterThan(0)
        const afterSource = prCommands()
        // The text the source was given is what the replay gets, whatever the briefing would be today.
        const sql = yield* SqlClient
        yield* sql`UPDATE context_snapshots SET text = ${"FROZEN BRIEFING"} WHERE task_id = ${source.id}`
        head.sha = OTHER_SHA

        const started = yield* (yield* replay).run(source.id)
        yield* lead.runOnce(started.task.id)

        expect(runs).toHaveLength(2)
        expect(runs[1]?.prompt).toBe(runs[0]?.prompt)
        expect(runs[1]?.systemAppend).toBe("FROZEN BRIEFING")
        expect(runs[0]?.systemAppend).not.toBe("FROZEN BRIEFING")
        expect(yield* snapshotText(started.task.id)).toBe("FROZEN BRIEFING")
        // The worktree is put on the source's commit before the executor starts.
        expect(tank.commands).toContainEqual(["git", "cat-file", "-e", `${SHA}^{commit}`])
        expect(tank.commands).toContainEqual(["git", "reset", "--hard", "--quiet", SHA])
        // A replay measures a run: no branch pushed, no PR opened.
        expect(prCommands()).toBe(afterSource)
      }).pipe(
        Effect.provide(
          leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS), runs), tank, liveBeacon: true }),
        ),
      )
    },
  )

  it.effect("a replay of a replay starts from the commit its own replay row kept", () => {
    const head = { sha: SHA }
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const source = yield* lead.intake(specFor(bot, { repo: REPO }))
      yield* lead.runOnce(source.id)
      head.sha = OTHER_SHA
      const first = yield* (yield* replay).run(source.id)
      yield* lead.runOnce(first.task.id)
      const second = yield* (yield* replay).run(first.task.id)
      expect(second.baseSha).toBe(SHA)
    }).pipe(
      Effect.provide(
        leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS)), tank: tankAt(head), liveBeacon: true }),
      ),
    )
  })

  it.effect("applies the executor, model and tier overrides to the run", () => {
    const claudeRuns: Runs = []
    const codexRuns: Runs = []
    const codex = { ...fakeExecutor(eventsOf(OK_EVENTS), codexRuns), id: CODEX }
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createTwoExecutorsBot
      const source = yield* lead.intake(specFor(bot, { tier: "heavy" }))
      yield* lead.runOnce(source.id)
      expect(claudeRuns).toHaveLength(1)

      const started = yield* (yield* replay).run(source.id, {
        executor: "codex",
        model: "gpt-test-1",
        tier: "heavy",
      })
      yield* lead.runOnce(started.task.id)

      expect(codexRuns).toHaveLength(1)
      expect(claudeRuns).toHaveLength(1)
      const executorStarted = (yield* streamEvents(started.task.id)).find(
        (event) => event.type === "executor.started",
      )
      expect(executorStarted?.payload).toMatchObject({ executor: "codex", model: "gpt-test-1" })
      expect(started.task.tier).toBe("heavy")
    }).pipe(
      Effect.provide(
        leadLayer({
          executor: fakeExecutor(eventsOf(OK_EVENTS), claudeRuns),
          extra: [codex],
          liveBeacon: true,
        }),
      ),
    )
  })

  it.effect("refuses an override that would widen the Bot, and creates nothing", () =>
    Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const source = yield* lead.intake(specFor(bot))
      yield* lead.runOnce(source.id)
      const replayer = yield* replay
      const sql = yield* SqlClient
      const tasks = () => sql`SELECT id FROM tasks`.pipe(Effect.map((rows) => rows.length))

      // The Bot allows claude-code only.
      const notAllowed = yield* Effect.flip(replayer.run(source.id, { executor: "codex" }))
      expect(notAllowed).toBeInstanceOf(SchemaViolation)
      expect(notAllowed).toMatchObject({ where: "overrides.executor" })
      // A model name is a plain token: it goes into argv.
      for (const model of ["--dangerously-skip", "a b", ""]) {
        expect(yield* Effect.flip(replayer.run(source.id, { model }))).toBeInstanceOf(SchemaViolation)
      }
      expect(yield* Effect.flip(replayer.run(source.id, { tier: "ultra" }))).toBeInstanceOf(SchemaViolation)
      expect(yield* tasks()).toBe(1)
      expect(yield* replayRows).toHaveLength(0)
    }).pipe(Effect.provide(leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS)), liveBeacon: true }))),
  )

  it.effect(
    "refuses an executor the source's review excluded, a task still running and an unknown task",
    () => {
      const codex = { ...fakeExecutor(eventsOf(OK_EVENTS)), id: CODEX }
      return Effect.gen(function* () {
        const lead = yield* Lead
        const bot = yield* createTwoExecutorsBot
        const reviewed = yield* lead.intake(specFor(bot, { review: { excludeExecutors: [CODEX] } }))
        yield* lead.runOnce(reviewed.id)
        const replayer = yield* replay
        expect(yield* Effect.flip(replayer.run(reviewed.id, { executor: "codex" }))).toMatchObject({
          where: "overrides.executor",
          issue: { reason: "excluded" },
        })
        const waiting = yield* lead.intake(specFor(bot))
        expect(yield* Effect.flip(replayer.run(waiting.id))).toMatchObject({
          issue: { reason: "not-finished" },
        })
        const unknown = "task_00000000-0000-4000-8000-000000000000" as TaskId
        expect(yield* Effect.flip(replayer.run(unknown))).toBeInstanceOf(NotFound)
      }).pipe(
        Effect.provide(
          leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS)), extra: [codex], liveBeacon: true }),
        ),
      )
    },
  )

  it.effect("the run narrows to what the Bot allows even if the stored row names another executor", () => {
    const codexRuns: Runs = []
    const codex = { ...fakeExecutor(eventsOf(OK_EVENTS), codexRuns), id: CODEX }
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const source = yield* lead.intake(specFor(bot, { tier: "heavy" }))
      yield* lead.runOnce(source.id)
      const other = yield* lead.intake(specFor(bot, { tier: "heavy" }))
      const sql = yield* SqlClient
      yield* sql`INSERT INTO replays (id, source_task_id, new_task_id, overrides, context_frozen, created_at)
        VALUES ('rpl_x', ${source.id}, ${other.id}, ${'{"executor":"codex"}'}, 0, '2026-10-21T00:00:00.000Z')`
      const verdict = yield* lead.runOnce(other.id)
      expect(verdict.kind).toBe("blocked")
      expect(codexRuns).toHaveLength(0)
    }).pipe(
      Effect.provide(
        leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS)), extra: [codex], liveBeacon: true }),
      ),
    )
  })
})

describe("Replay.compare", () => {
  it.effect("puts the verdict, cost, executor and files of both runs side by side", () => {
    let call = 0
    const stream = () => {
      call += 1
      return call === 1
        ? Stream.fromIterable(executorEvents(edit("a.ts"), edit("b.ts")))
        : Stream.fromIterable<ExecutorEvent>([
            { kind: "started", sessionId: SESSION },
            edit("b.ts"),
            edit("c.ts"),
            USAGE_EVENT,
            USAGE_EVENT,
            { kind: "error", code: "auth", message: "login required" },
          ])
    }
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const source = yield* lead.intake(specFor(bot))
      yield* lead.runOnce(source.id)
      const replayer = yield* replay
      const started = yield* replayer.run(source.id)
      yield* lead.runOnce(started.task.id)

      const comparison = yield* replayer.compare(started.replayId)

      expect(comparison).toMatchObject({
        id: started.replayId,
        sourceTaskId: source.id,
        newTaskId: started.task.id,
      })
      expect(comparison.source.verdict?.kind).toBe("ok")
      expect(comparison.replay.verdict?.kind).not.toBe("ok")
      expect(comparison.diff.verdictChanged).toBe(true)
      expect(comparison.source.files).toEqual(["a.ts", "b.ts"])
      expect(comparison.replay.files).toEqual(["b.ts", "c.ts"])
      expect(comparison.diff.filesOnlyInSource).toEqual(["a.ts"])
      expect(comparison.diff.filesOnlyInReplay).toEqual(["c.ts"])
      expect(comparison.source.usage.usd).toBeCloseTo(0.25)
      expect(comparison.replay.usage.usd).toBeCloseTo(0.5)
      expect(comparison.diff.usdDelta).toBeCloseTo(0.25)
      expect(comparison.source.executor).toBe("claude-code")
      expect(comparison.diff.executorChanged).toBe(false)
      expect(comparison.notes).toEqual([])
    }).pipe(Effect.provide(leadLayer({ executor: fakeExecutor(stream), liveBeacon: true })))
  })

  it.effect("fails with NotFound for an unknown replay", () =>
    Effect.gen(function* () {
      expect(yield* Effect.flip((yield* replay).compare("rpl_nope"))).toBeInstanceOf(NotFound)
    }).pipe(Effect.provide(leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS)), liveBeacon: true }))),
  )

  it.effect("says so when the recorded base commit was not in the clone", () => {
    const head = { sha: SHA }
    const tank = makeFakeTank({
      exec: (argv) => {
        const line = argv.join(" ")
        if (line === "git rev-parse HEAD") return exitZero(`${head.sha}\n`)
        if (line.startsWith("git cat-file")) return { ...exitZero(""), exitCode: 1 }
        return HEALTHY_EXEC(argv)
      },
    })
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const source = yield* lead.intake(specFor(bot, { repo: REPO }))
      yield* lead.runOnce(source.id)
      const replayer = yield* replay
      const started = yield* replayer.run(source.id)
      yield* lead.runOnce(started.task.id)
      expect((yield* replayer.compare(started.replayId)).notes).toHaveLength(1)
    }).pipe(
      Effect.provide(leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS)), tank, liveBeacon: true })),
    )
  })
})
