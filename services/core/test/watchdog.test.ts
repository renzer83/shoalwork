import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { Beacon, BeaconLive } from "@shoalwork/beacon"
import { BotRegistry, BotRegistryLive } from "@shoalwork/bots"
import { type Bot, NewBot, newApprovalId, type TaskId, type TaskSpec } from "@shoalwork/contracts"
import { GhClientTest } from "@shoalwork/currents"
import { Jobs } from "@shoalwork/db"
import { withTempDb } from "@shoalwork/db/testing"
import { makeRegistry } from "@shoalwork/executors"
import { Lead, LeadWithStore, stepIdFor, TASKS_QUEUE } from "@shoalwork/lead"
import { makeTankLocal, spawnProcess, Tank, TankLocalLive } from "@shoalwork/tank"
import { Duration, Effect, Layer, Schema, Stream } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { afterAll, describe, expect } from "vitest"
import { DEFAULT_TIERS } from "../src/model-tiers.js"
import { runWatchdogCycle, startWatchdog, type WatchdogConfig } from "../src/watchdog.js"

const tankRoot = mkdtempSync(join(tmpdir(), "shoalwork-watchdog-tank-"))
afterAll(() => {
  rmSync(tankRoot, { recursive: true, force: true })
})

// Real database, real Beacon, real Lead (with its store) and the real local Tank; each test builds its own copy.
const TestLayer = LeadWithStore(DEFAULT_TIERS).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      BotRegistryLive,
      TankLocalLive({ root: tankRoot, baseEnv: {} }),
      makeRegistry([]),
      GhClientTest().layer,
    ),
  ),
  Layer.provideMerge(Layer.provideMerge(BeaconLive, withTempDb())),
)

const NEW_BOT = Schema.decodeUnknownSync(NewBot)({
  name: "watchdog-bot",
  role: "developer",
  kind: "auxiliary",
  instructions: "Do nothing.",
  executors: { preferred: "claude-code", allowed: ["claude-code"] },
  modelTiers: {},
  connectors: [],
  budget: { tokens: 200000, seconds: 1800, usd: 2 },
  policy: "default",
  tank: { mode: "local", host: "mac" },
  memory: { scope: "bot" },
})

const NORMAL: WatchdogConfig = { intervalMs: 300_000, staleMinutes: 20, maxProcessMinutes: 45 }
// Thresholds of a few milliseconds: the real clock passes them during the test.
const IMPATIENT: WatchdogConfig = { intervalMs: 300_000, staleMinutes: 0.0005, maxProcessMinutes: 0.0005 }

const RecoveredPayload = Schema.Struct({ what: Schema.String, ref: Schema.String, action: Schema.String })

const makeBot = Effect.gen(function* () {
  const registry = yield* BotRegistry
  return yield* registry.upsert(NEW_BOT, "test")
})

const intakeTask = (bot: Bot, repo?: { readonly url: string; readonly base: string }) =>
  Effect.gen(function* () {
    const lead = yield* Lead
    const input: Omit<TaskSpec, "id"> = {
      botId: bot.id,
      title: "watchdog task",
      prompt: "wait",
      kind: "chat",
      acceptance: [],
      budget: { tokens: 1000, seconds: 1800, usd: 1 },
      tier: "chat",
      origin: "api",
      ...(repo === undefined ? {} : { repo }),
    }
    return yield* lead.intake(input)
  })

// Simulates a worker that claimed the task's job and started the run.
const markRunning = (taskId: TaskId, attempts: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const claimed = yield* Jobs.claim(TASKS_QUEUE)
    yield* sql`UPDATE tasks SET state = 'running', attempts = ${attempts} WHERE id = ${taskId}`
    return claimed
  })

const jobIdOf = (taskId: TaskId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const rows = yield* sql<{ readonly id: number }>`SELECT id FROM jobs
      WHERE json_extract(payload, '$.taskId') = ${taskId} ORDER BY id DESC LIMIT 1`
    return rows[0]?.id ?? -1
  })

const jobState = (taskId: TaskId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const rows = yield* sql<{ readonly state: string }>`SELECT state FROM jobs
      WHERE json_extract(payload, '$.taskId') = ${taskId} ORDER BY id DESC LIMIT 1`
    return rows[0]?.state
  })

const recoveredEvents = Effect.gen(function* () {
  const beacon = yield* Beacon
  const events = yield* Stream.runCollect(beacon.readAll(0, ["watchdog.recovered"]))
  return Array.from(events).map((event) => Schema.decodeUnknownSync(RecoveredPayload)(event.payload))
})

const sleepMs = (ms: number) => Effect.sleep(Duration.millis(ms))

describe("watchdog", () => {
  it.live("a stale running task with attempts left is requeued and the job is handed out again", () =>
    Effect.gen(function* () {
      const bot = yield* makeBot
      const spec = yield* intakeTask(bot)
      yield* markRunning(spec.id, 1)
      yield* sleepMs(50)
      yield* runWatchdogCycle(IMPATIENT)

      expect(yield* jobState(spec.id)).toBe("queued")
      expect((yield* (yield* Lead).get(spec.id)).state).toBe("running")
      expect(yield* recoveredEvents).toEqual([{ what: "stale_task", ref: spec.id, action: "requeued" }])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.live("a stale running task out of attempts is stopped and its task is cancelled by the watchdog", () =>
    Effect.gen(function* () {
      const bot = yield* makeBot
      const spec = yield* intakeTask(bot)
      yield* markRunning(spec.id, 2)
      yield* sleepMs(50)
      yield* runWatchdogCycle(IMPATIENT)

      const record = yield* (yield* Lead).get(spec.id)
      expect(record.state).toBe("cancelled")
      expect(record.verdict?.kind).toBe("blocked")
      expect(record.verdict?.evidence).toEqual(["stopped by watchdog"])
      expect(yield* jobState(spec.id)).not.toBe("active")
      expect(yield* recoveredEvents).toEqual([{ what: "stale_task", ref: spec.id, action: "stopped" }])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.live("a job without a heartbeat goes back to the queue and is recorded as stale_job", () =>
    Effect.gen(function* () {
      const bot = yield* makeBot
      const spec = yield* intakeTask(bot)
      const sql = yield* SqlClient
      yield* Jobs.claim(TASKS_QUEUE)
      yield* sql`UPDATE jobs SET heartbeat_at = '2000-01-01T00:00:00.000Z' WHERE queue = ${TASKS_QUEUE}`
      const jobId = yield* jobIdOf(spec.id)
      yield* runWatchdogCycle(NORMAL)

      expect(yield* jobState(spec.id)).toBe("queued")
      expect(yield* recoveredEvents).toEqual([{ what: "stale_job", ref: `job:${jobId}`, action: "requeued" }])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.live("a job out of attempts without a heartbeat fails and its task closes", () =>
    Effect.gen(function* () {
      const bot = yield* makeBot
      const spec = yield* intakeTask(bot)
      const sql = yield* SqlClient
      yield* Jobs.claim(TASKS_QUEUE)
      yield* sql`UPDATE jobs SET attempts = 3, heartbeat_at = '2000-01-01T00:00:00.000Z' WHERE queue = ${TASKS_QUEUE}`
      const jobId = yield* jobIdOf(spec.id)
      yield* runWatchdogCycle(NORMAL)

      expect(yield* jobState(spec.id)).toBe("failed")
      expect((yield* (yield* Lead).get(spec.id)).state).toBe("failed")
      expect(yield* recoveredEvents).toEqual([{ what: "stale_job", ref: `job:${jobId}`, action: "failed" }])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a bot marked working with no running task goes idle", () =>
    Effect.gen(function* () {
      const bot = yield* makeBot
      const registry = yield* BotRegistry
      yield* registry.setState(bot.id, "working")
      yield* runWatchdogCycle(NORMAL)

      const listed = yield* registry.list()
      expect(listed.find((b) => b.id === bot.id)?.state).toBe("idle")
      expect(yield* recoveredEvents).toEqual([
        { what: "state_mismatch", ref: `bot:${bot.id}`, action: "idle" },
      ])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a cycle with nothing to do records no event", () =>
    Effect.gen(function* () {
      yield* runWatchdogCycle(NORMAL)

      expect(yield* recoveredEvents).toEqual([])
      const beacon = yield* Beacon
      const errors = yield* Stream.runCollect(beacon.readAll(0, ["error.raised"]))
      expect(Array.from(errors)).toEqual([])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.live("a Tank process alive past the limit is killed and recorded", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const proc = yield* spawnProcess(["sleep", "30"], { cwd: tankRoot, env: { PATH: "/usr/bin:/bin" } })
        yield* sleepMs(50)
        yield* runWatchdogCycle(IMPATIENT)
        const exitCode = yield* proc.exitCode

        expect(exitCode).toBeGreaterThan(0)
        const events = yield* recoveredEvents
        expect(events).toEqual([{ what: "long_process", ref: `pid:${proc.pid}`, action: "killed" }])
      }),
    ).pipe(Effect.provide(TestLayer)),
  )

  it.live("the wait for an inline approval is not part of the age of the process of that run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const bot = yield* makeBot
        const spec = yield* intakeTask(bot)
        const proc = yield* spawnProcess(["sleep", "30"], { cwd: tankRoot, env: { PATH: "/usr/bin:/bin" } })
        const sql = yield* SqlClient
        yield* sql`INSERT INTO task_processes (task_id, pgid, started_at) VALUES (${spec.id}, ${proc.pid}, '2999-01-01T00:00:00.000Z')`
        // Ten minutes of work, then forty waiting for a person: the request began after the process did.
        yield* sql`INSERT INTO approvals (id, task_id, bot_id, action, action_hash, risk, status, requested_at,
          expires_at, resolved_at, resolved_by, mode)
          VALUES (${newApprovalId()}, ${spec.id}, ${bot.id}, '{"tool":"Bash","input":"git push"}', 'h', 'external',
            'approved', '2999-01-01T00:10:00.000Z', '2999-01-01T02:10:00.000Z', '2999-01-01T00:50:00.000Z',
            'user:web', 'inline')`
        yield* sleepMs(50)
        yield* runWatchdogCycle(IMPATIENT)
        expect(yield* recoveredEvents).toEqual([])
      }),
    ).pipe(Effect.provide(TestLayer)),
  )

  it.live("worktrees of a task settled over a day ago are removed, a running task's are not", () =>
    Effect.gen(function* () {
      const bot = yield* makeBot
      const old = yield* intakeTask(bot, { url: "https://example.invalid/repo.git", base: "main" })
      const live = yield* intakeTask(bot, { url: "https://example.invalid/repo.git", base: "main" })
      const sql = yield* SqlClient
      yield* sql`UPDATE tasks SET state = 'failed', updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ${old.id}`
      yield* sql`UPDATE tasks SET state = 'running' WHERE id = ${live.id}`
      const oldBranch = `bot/${bot.name}/${stepIdFor(old.id, 1)}`
      const liveBranch = `bot/${bot.name}/${stepIdFor(live.id, 1)}`
      const removed: Array<string> = []
      const fakeTank = {
        ...makeTankLocal({ root: tankRoot, baseEnv: {} }),
        worktrees: () =>
          Effect.succeed([
            { repoDir: join(tankRoot, "repo"), path: join(tankRoot, "old"), branch: oldBranch },
            { repoDir: join(tankRoot, "repo"), path: join(tankRoot, "live"), branch: liveBranch },
          ]),
        removeWorktree: (_bot: Bot, wt: { readonly branch: string }) =>
          Effect.sync(() => {
            removed.push(wt.branch)
          }),
      }
      yield* runWatchdogCycle(NORMAL).pipe(Effect.provideService(Tank, fakeTank))

      expect(removed).toEqual([oldBranch])
      expect(yield* recoveredEvents).toEqual([{ what: "orphan_worktree", ref: oldBranch, action: "removed" }])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("the loop runs on the five-minute cadence, starting with an immediate cycle", () =>
    Effect.gen(function* () {
      const bot = yield* makeBot
      const old = yield* intakeTask(bot, { url: "https://example.invalid/repo.git", base: "main" })
      const sql = yield* SqlClient
      yield* sql`UPDATE tasks SET state = 'done', updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ${old.id}`
      // The test clock starts at epoch 0; the cutoff is measured from it, so start it at the real time.
      yield* TestClock.setTime(Date.now())
      let sweeps = 0
      const countingTank = {
        ...makeTankLocal({ root: tankRoot, baseEnv: {} }),
        worktrees: () =>
          Effect.sync(() => {
            sweeps++
            return []
          }),
      }
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* startWatchdog(NORMAL)
          yield* TestClock.adjust(Duration.millis(1))
          expect(sweeps).toBe(1)
          yield* TestClock.adjust(Duration.millis(299_998))
          expect(sweeps).toBe(1)
          yield* TestClock.adjust(Duration.millis(1))
          expect(sweeps).toBe(2)
        }),
      ).pipe(Effect.provideService(Tank, countingTank))
    }).pipe(Effect.provide(TestLayer)),
  )
})
