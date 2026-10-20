import { it } from "@effect/vitest"
import { Beacon, BeaconTest } from "@shoalwork/beacon"
import { newTaskId, type Risk } from "@shoalwork/contracts"
import { withTempDb } from "@shoalwork/db/testing"
import { Effect, Layer, Option, Stream } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { describe, expect } from "vitest"
import {
  APPROVAL_TTL_MS,
  Approvals,
  ApprovalsLive,
  actionHashOf,
  EXPIRY_ACTOR,
  makeApprovalsLive,
  redactText,
} from "../src/index.js"
import { BOT } from "./support.js"

const layer = ApprovalsLive.pipe(Layer.provideMerge(BeaconTest), Layer.provideMerge(withTempDb()))

const ACTION = { tool: "Bash", input: { command: "rm -rf build" }, resource: "build/" }
const RISK: Risk = "irreversible"

// Approvals reference real rows (foreign keys): a Bot and a task to ask on behalf of.
const seedTask = Effect.gen(function* () {
  const sql = yield* SqlClient
  const taskId = newTaskId()
  const now = new Date(0).toISOString()
  yield* sql`INSERT OR IGNORE INTO bots (id, name, definition, state, updated_at)
    VALUES (${BOT}, 'approver', '{}', 'idle', ${now})`
  yield* sql`INSERT INTO tasks (id, bot_id, spec, state, created_at, updated_at)
    VALUES (${taskId}, ${BOT}, '{}', 'waiting_approval', ${now}, ${now})`
  return taskId
})

const ask = Effect.gen(function* () {
  const approvals = yield* Approvals
  return yield* approvals.request({ taskId: yield* seedTask, botId: BOT, action: ACTION, risk: RISK })
})

const eventTypes = Effect.gen(function* () {
  const beacon = yield* Beacon
  return (yield* Stream.runCollect(beacon.readAll())).map((event) => event.type)
})

describe("Approvals", () => {
  it.effect("request stores a pending approval that expires in 2 hours and emits approval.requested", () =>
    Effect.gen(function* () {
      const approval = yield* ask
      expect(approval.status).toBe("pending")
      expect(approval.expiresAt.epochMilliseconds - approval.requestedAt.epochMilliseconds).toBe(
        APPROVAL_TTL_MS,
      )
      expect(approval.action).toMatchObject({ tool: "Bash", resource: "build/" })
      expect(yield* eventTypes).toEqual(["approval.requested"])
      const pending = yield* (yield* Approvals).listPending()
      expect(pending.map((entry) => entry.id)).toEqual([approval.id])
    }).pipe(Effect.provide(layer)),
  )

  it.effect("redacts secrets and cuts a long input before storing the action", () =>
    Effect.gen(function* () {
      const approvals = yield* Approvals
      const created = yield* approvals.request({
        taskId: yield* seedTask,
        botId: BOT,
        action: { tool: "Bash", input: { command: `curl https://x.test/?token=SECRET ${"a".repeat(5000)}` } },
        risk: RISK,
      })
      const text = String(created.action.input)
      expect(text).not.toContain("SECRET")
      expect(text.length).toBeLessThan(2100)
    }).pipe(Effect.provide(layer)),
  )

  it.effect("approving resolves once; a second click or channel only reads the stored decision", () =>
    Effect.gen(function* () {
      const approvals = yield* Approvals
      const approval = yield* ask
      const first = yield* approvals.resolve(approval.id, "approved", "user:telegram:1")
      const second = yield* approvals.resolve(approval.id, "denied", "user:web")
      expect(first).toMatchObject({ _tag: "Resolved", approval: { status: "approved" } })
      expect(second).toMatchObject({
        _tag: "AlreadyResolved",
        approval: { status: "approved", resolvedBy: "user:telegram:1" },
      })
      expect((yield* eventTypes).filter((type) => type === "approval.resolved")).toHaveLength(1)
    }).pipe(Effect.provide(layer)),
  )

  it.effect("denying records the decision and the author", () =>
    Effect.gen(function* () {
      const approvals = yield* Approvals
      const approval = yield* ask
      const result = yield* approvals.resolve(approval.id, "denied", "user:cli")
      expect(result).toMatchObject({
        _tag: "Resolved",
        approval: { status: "denied", resolvedBy: "user:cli" },
      })
      expect(yield* approvals.listPending()).toEqual([])
    }).pipe(Effect.provide(layer)),
  )

  it.effect("an unknown approval is NotFound", () =>
    Effect.gen(function* () {
      const approvals = yield* Approvals
      const approval = yield* ask
      const error = yield* approvals.get(approval.id).pipe(Effect.flip, Effect.option)
      expect(Option.isNone(error)).toBe(true)
      const missing = yield* approvals
        .resolve("apr_00000000-0000-4000-8000-000000000000" as typeof approval.id, "approved", "x")
        .pipe(Effect.flip)
      expect(missing._tag).toBe("NotFound")
    }).pipe(Effect.provide(layer)),
  )

  it.effect("expireDue expires only what is due, once, and denies by default", () =>
    Effect.gen(function* () {
      const approvals = yield* Approvals
      const approval = yield* ask
      expect(yield* approvals.expireDue()).toEqual([])
      yield* TestClock.adjust(APPROVAL_TTL_MS + 1)
      const expired = yield* approvals.expireDue()
      expect(expired.map((entry) => entry.id)).toEqual([approval.id])
      expect(expired[0]).toMatchObject({ status: "expired", resolvedBy: EXPIRY_ACTOR })
      expect(yield* approvals.expireDue()).toEqual([])
      expect((yield* eventTypes).filter((type) => type === "approval.resolved")).toHaveLength(1)
    }).pipe(Effect.provide(layer)),
  )

  it.effect("a late approval of a due request is refused and the request is expired", () =>
    Effect.gen(function* () {
      const approvals = yield* Approvals
      const approval = yield* ask
      yield* TestClock.adjust(APPROVAL_TTL_MS)
      const result = yield* approvals.resolve(approval.id, "approved", "user:web")
      expect(result).toMatchObject({ _tag: "AlreadyResolved", approval: { status: "expired" } })
    }).pipe(Effect.provide(layer)),
  )

  it.effect("list filters by status and latestForTask finds the newest", () =>
    Effect.gen(function* () {
      const approvals = yield* Approvals
      const first = yield* ask
      const second = yield* ask
      yield* approvals.resolve(first.id, "approved", "user:web")
      expect((yield* approvals.list({ status: "pending" })).map((entry) => entry.id)).toEqual([second.id])
      expect((yield* approvals.list()).length).toBe(2)
      const latest = yield* approvals.latestForTask(second.taskId)
      expect(Option.map(latest, (entry) => entry.id)).toEqual(Option.some(second.id))
    }).pipe(Effect.provide(layer)),
  )

  it.effect("attachMessage keeps where the card is", () =>
    Effect.gen(function* () {
      const approvals = yield* Approvals
      const approval = yield* ask
      yield* approvals.attachMessage(approval.id, { chatId: "-100", threadId: 7, messageId: 42 })
      expect(yield* approvals.get(approval.id)).toMatchObject({ chatId: "-100", threadId: 7, messageId: 42 })
    }).pipe(Effect.provide(layer)),
  )

  it.effect("a decision is used once: consume succeeds for a decided approval only the first time", () =>
    Effect.gen(function* () {
      const approvals = yield* Approvals
      const approval = yield* ask
      expect(yield* approvals.consume(approval.id)).toBe(false)
      yield* approvals.resolve(approval.id, "approved", "user:web")
      expect(yield* approvals.consume(approval.id)).toBe(true)
      expect(yield* approvals.consume(approval.id)).toBe(false)
      expect((yield* approvals.get(approval.id)).consumedAt).toBeDefined()
    }).pipe(Effect.provide(layer)),
  )

  it.effect("asking again while a request is pending returns it: one open request per task", () =>
    Effect.gen(function* () {
      const approvals = yield* Approvals
      const taskId = yield* seedTask
      const first = yield* approvals.request({ taskId, botId: BOT, action: ACTION, risk: RISK })
      const again = yield* approvals.request({ taskId, botId: BOT, action: ACTION, risk: RISK })
      expect(again.id).toBe(first.id)
      expect((yield* eventTypes).filter((type) => type === "approval.requested")).toHaveLength(1)
    }).pipe(Effect.provide(layer)),
  )

  it.effect("expireForTask ends the pending request with an event", () =>
    Effect.gen(function* () {
      const approvals = yield* Approvals
      const approval = yield* ask
      const ended = yield* approvals.expireForTask(approval.taskId, "system:stop")
      expect(ended.map((entry) => entry.id)).toEqual([approval.id])
      expect(yield* approvals.get(approval.id)).toMatchObject({
        status: "expired",
        resolvedBy: "system:stop",
      })
      expect(yield* approvals.expireForTask(approval.taskId, "system:stop")).toEqual([])
    }).pipe(Effect.provide(layer)),
  )

  it.effect("a request references a real task and Bot", () =>
    Effect.gen(function* () {
      const approvals = yield* Approvals
      const error = yield* approvals
        .request({ taskId: newTaskId(), botId: BOT, action: ACTION, risk: RISK })
        .pipe(Effect.flip)
      expect(error._tag).toBe("SqlError")
    }).pipe(Effect.provide(layer)),
  )

  it.effect("the ttl option sets the expiry", () =>
    Effect.gen(function* () {
      const approval = yield* ask
      expect(approval.expiresAt.epochMilliseconds - approval.requestedAt.epochMilliseconds).toBe(30 * 60_000)
    }).pipe(
      Effect.provide(
        makeApprovalsLive({ ttlMs: 30 * 60_000 }).pipe(
          Layer.provideMerge(BeaconTest),
          Layer.provideMerge(withTempDb()),
        ),
      ),
    ),
  )

  it.effect("the action hash binds tool + canonical input, whatever the key order", () =>
    Effect.gen(function* () {
      const approval = yield* ask
      expect(approval.actionHash).toBe(actionHashOf(ACTION))
      const reordered = { tool: "Bash", input: { b: 1, a: { d: 2, c: 3 } } }
      const other = { tool: "Bash", input: { a: { c: 3, d: 2 }, b: 1 } }
      expect(actionHashOf(reordered)).toBe(actionHashOf(other))
      expect(actionHashOf({ ...other, tool: "Write" })).not.toBe(actionHashOf(other))
    }).pipe(Effect.provide(layer)),
  )
})

describe("redactText", () => {
  it("masks credentials with no query string in sight", () => {
    const samples = [
      'curl -H "Authorization: Bearer abc123def456ghi789" https://x.test/api',
      "curl -H 'X-Api-Key: topsecretvalue' https://x.test",
      "deploy --password=hunter2 --region eu",
      "deploy --token s3cr3tvalue",
      "export API_KEY=abcdef123456 && run",
      "git clone https://user:p4ssw0rd@github.com/x/y",
      "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "Authorization: Basic dXNlcjpwYXNz",
    ]
    for (const sample of samples) {
      const out = redactText(sample)
      expect(out).toContain("[redacted]")
      expect(out).not.toMatch(
        /abc123def456|topsecretvalue|hunter2|s3cr3tvalue|abcdef123456|p4ssw0rd|ghp_abc|dXNlcjpwYXNz/,
      )
    }
    expect(redactText("deploy --password=hunter2 --region eu")).toContain("--region eu")
  })

  it.effect("stored actions never keep the credentials of the input", () =>
    Effect.gen(function* () {
      const approvals = yield* Approvals
      const created = yield* approvals.request({
        taskId: yield* seedTask,
        botId: BOT,
        action: {
          tool: "Bash",
          input: { command: 'curl -H "Authorization: Bearer abc123def456ghi789" https://x.test' },
        },
        risk: RISK,
      })
      expect(String(created.action.input)).not.toContain("abc123def456")
    }).pipe(Effect.provide(layer)),
  )
})
