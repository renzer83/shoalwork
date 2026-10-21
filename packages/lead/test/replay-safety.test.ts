import { it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import { saveSnapshot } from "../src/replay-store.js"
import { createTwoExecutorsBot, Lead, OTHER_SHA, replay, SHA, streamEvents } from "./replay-support.js"
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
  specFor,
} from "./support.js"

const REPO = { url: "https://github.com/renzer83/shoalwork-sandbox", base: "main" } as const

const exit = (stdout: string, exitCode = 0) => ({
  exitCode,
  stdout,
  stderr: "",
  durationMs: 1,
  timedOut: false,
})

// A Tank whose HEAD follows `git reset --hard <sha>`, like a real worktree. `head.sha` is the tip a new worktree is cut at.
const trackingTank = (head: { sha: string }) =>
  makeFakeTank({
    exec: (argv) => {
      const line = argv.join(" ")
      if (line === "git rev-parse HEAD") return exit(`${head.sha}\n`)
      if (argv[0] === "git" && argv[1] === "reset") {
        head.sha = argv.at(-1) ?? head.sha
        return exit("")
      }
      return HEALTHY_EXEC(argv)
    },
  })

const stagedFiles = (tank: ReturnType<typeof makeFakeTank>) =>
  tank.commands.filter((argv) => argv[1] === "add").length

const errorsOf = (taskId: Parameters<typeof streamEvents>[0]) =>
  Effect.map(streamEvents(taskId), (events) => events.filter((event) => event.type === "error.raised"))

describe("replay base", () => {
  it.effect(
    "records the commit the replay really starts from: the alignment comes before executor.started",
    () => {
      const head = { sha: SHA }
      const tank = trackingTank(head)
      return Effect.gen(function* () {
        const lead = yield* Lead
        const bot = yield* createBot
        const source = yield* lead.intake(specFor(bot, { repo: REPO }))
        yield* lead.runOnce(source.id)
        // The branch moved on: a new worktree is cut at the new tip.
        head.sha = OTHER_SHA

        const started = yield* (yield* replay).run(source.id)
        yield* lead.runOnce(started.task.id)

        const payload = (yield* streamEvents(started.task.id)).find(
          (event) => event.type === "executor.started",
        )?.payload
        expect(payload).toMatchObject({ baseSha: SHA })
        expect(started.baseSha).toBe(SHA)
        expect(head.sha).toBe(SHA)
      }).pipe(
        Effect.provide(leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS)), tank, liveBeacon: true })),
      )
    },
  )
})

describe("replay fails closed", () => {
  const unusable: ReadonlyArray<readonly [string, (sql: SqlClient) => Effect.Effect<unknown, unknown>]> = [
    ["the replay table cannot be read", (sql) => sql`ALTER TABLE replays RENAME TO replays_gone`],
    ["the replay row does not decode", (sql) => sql`UPDATE replays SET overrides = 'not json'`],
    ["the frozen context is gone", (sql) => sql`DELETE FROM context_snapshots`],
  ]

  for (const [label, damage] of unusable) {
    it.effect(`does not run, nor deliver, when ${label}`, () => {
      const runs: Runs = []
      const tank = trackingTank({ sha: SHA })
      return Effect.gen(function* () {
        const lead = yield* Lead
        const bot = yield* createBot
        const source = yield* lead.intake(specFor(bot, { repo: REPO }))
        yield* lead.runOnce(source.id)
        const delivered = stagedFiles(tank)
        expect(delivered).toBeGreaterThan(0)
        const started = yield* (yield* replay).run(source.id)
        yield* damage(yield* SqlClient)

        const verdict = yield* lead.runOnce(started.task.id)

        expect(verdict.kind).not.toBe("ok")
        expect(runs).toHaveLength(1)
        expect(stagedFiles(tank)).toBe(delivered)
        expect((yield* errorsOf(started.task.id)).length).toBeGreaterThan(0)
      }).pipe(
        Effect.provide(
          leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS), runs), tank, liveBeacon: true }),
        ),
      )
    })
  }

  it.effect("does not run a replay whose base commit is not in the clone", () => {
    const runs: Runs = []
    const tank = makeFakeTank({
      exec: (argv) =>
        argv.join(" ") === "git rev-parse HEAD"
          ? exit(`${SHA}\n`)
          : argv[1] === "cat-file"
            ? exit("", 1)
            : HEALTHY_EXEC(argv),
    })
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const source = yield* lead.intake(specFor(bot, { repo: REPO }))
      yield* lead.runOnce(source.id)
      const started = yield* (yield* replay).run(source.id)

      const verdict = yield* lead.runOnce(started.task.id)

      expect(verdict.kind).not.toBe("ok")
      expect(runs).toHaveLength(1)
      expect((yield* (yield* replay).compare(started.replayId)).notes.join(" ")).toContain("did not run")
    }).pipe(
      Effect.provide(
        leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS), runs), tank, liveBeacon: true }),
      ),
    )
  })
})

describe("replay model override", () => {
  it.effect("applies the model on the source's executor when no executor is named", () =>
    Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const source = yield* lead.intake(specFor(bot))
      yield* lead.runOnce(source.id)
      const started = yield* (yield* replay).run(source.id, { model: "model-x" })
      yield* lead.runOnce(started.task.id)
      const payload = (yield* streamEvents(started.task.id)).find(
        (event) => event.type === "executor.started",
      )?.payload
      expect(payload).toMatchObject({ executor: "claude-code", model: "model-x" })
    }).pipe(Effect.provide(leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS)), liveBeacon: true }))),
  )

  it.effect("ignores the model when the executor chosen is not the one it was meant for", () => {
    const codex = { ...fakeExecutor(eventsOf(OK_EVENTS)), id: CODEX }
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createTwoExecutorsBot
      const source = yield* lead.intake(specFor(bot))
      yield* lead.runOnce(source.id)
      const other = yield* lead.intake(specFor(bot))
      const sql = yield* SqlClient
      yield* sql`INSERT INTO replays (id, source_task_id, new_task_id, overrides, model_executor, context_frozen, created_at)
        VALUES ('rpl_m', ${source.id}, ${other.id}, ${'{"model":"model-x"}'}, 'codex', 0, '2026-10-21T00:00:00.000Z')`
      yield* lead.runOnce(other.id)
      const payload = (yield* streamEvents(other.id)).find(
        (event) => event.type === "executor.started",
      )?.payload
      expect(payload).toMatchObject({ executor: "claude-code" })
      expect(payload).not.toMatchObject({ model: "model-x" })
    }).pipe(
      Effect.provide(
        leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS)), extra: [codex], liveBeacon: true }),
      ),
    )
  })
})

describe("context snapshot", () => {
  it.effect("is redacted, keeps the first attempt and goes away with its task", () =>
    Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const leaked = `ghp_${"a".repeat(30)}`
      const source = yield* lead.intake(specFor(bot, { title: `Deploy with ${leaked} now` }))
      yield* lead.runOnce(source.id)
      const sql = yield* SqlClient
      const text = () =>
        sql<{ readonly text: string }>`SELECT text FROM context_snapshots WHERE task_id = ${source.id}`.pipe(
          Effect.map((rows) => rows[0]?.text),
        )
      const first = yield* text()
      expect(first).toContain("# Current task")
      expect(first).not.toContain(leaked)

      yield* saveSnapshot(sql, source.id, { text: "second attempt", level: "full", used: 1, budget: 1 })
      expect(yield* text()).toBe(first)

      yield* sql`DELETE FROM tasks WHERE id = ${source.id}`
      expect(yield* text()).toBeUndefined()
    }).pipe(Effect.provide(leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS)), liveBeacon: true }))),
  )
})
