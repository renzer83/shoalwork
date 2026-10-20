import { it } from "@effect/vitest"
import { BeaconTest } from "@shoalwork/beacon"
import { newTaskId, type TaskId, type ToolCall } from "@shoalwork/contracts"
import { withTempDb } from "@shoalwork/db/testing"
import { Duration, Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { describe, expect } from "vitest"
import { APPROVAL_TTL_MS, Approvals, ApprovalsLive, actionHashOf } from "../src/index.js"
import { BOT } from "./support.js"

const layer = ApprovalsLive.pipe(Layer.provideMerge(BeaconTest), Layer.provideMerge(withTempDb()))

const PUSH: ToolCall = { tool: "Bash", input: { command: "git push origin main", description: "push" } }
// Same keys in another order: the hash is over the canonical form.
const PUSH_REORDERED: ToolCall = {
  tool: "Bash",
  input: { description: "push", command: "git push origin main" },
}
const OTHER: ToolCall = { tool: "Bash", input: { command: "git push --force origin main" } }

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

const approved = (taskId: TaskId, call: ToolCall) =>
  Effect.gen(function* () {
    const approvals = yield* Approvals
    const record = yield* approvals.request({ taskId, botId: BOT, action: call, risk: "irreversible" })
    yield* approvals.resolve(record.id, "approved", "user:cli")
    return record
  })

describe("Approvals.consumeMatching", () => {
  it.effect("uses up the approved approval once, for the same tool and input only", () =>
    Effect.gen(function* () {
      const approvals = yield* Approvals
      const taskId = yield* seedTask
      const record = yield* approved(taskId, PUSH)
      const first = yield* approvals.consumeMatching(taskId, PUSH_REORDERED)
      expect(Option.map(first, (entry) => entry.id)).toEqual(Option.some(record.id))
      expect(Option.isSome(first) && first.value.consumedAt !== undefined).toBe(true)
      expect(Option.isNone(yield* approvals.consumeMatching(taskId, PUSH))).toBe(true)
    }).pipe(Effect.provide(layer)),
  )

  it.effect("a different input does not use the approval and leaves it for the right call", () =>
    Effect.gen(function* () {
      const approvals = yield* Approvals
      const taskId = yield* seedTask
      yield* approved(taskId, PUSH)
      expect(Option.isNone(yield* approvals.consumeMatching(taskId, OTHER))).toBe(true)
      expect(Option.isSome(yield* approvals.consumeMatching(taskId, PUSH))).toBe(true)
    }).pipe(Effect.provide(layer)),
  )

  it.effect("ignores pending, denied and other tasks' approvals", () =>
    Effect.gen(function* () {
      const approvals = yield* Approvals
      const taskId = yield* seedTask
      const otherTask = yield* seedTask
      yield* approved(otherTask, PUSH)
      expect(Option.isNone(yield* approvals.consumeMatching(taskId, PUSH))).toBe(true)
      const pending = yield* approvals.request({
        taskId,
        botId: BOT,
        action: PUSH,
        risk: "irreversible",
      })
      expect(Option.isNone(yield* approvals.consumeMatching(taskId, PUSH))).toBe(true)
      yield* approvals.resolve(pending.id, "denied", "user:cli")
      expect(Option.isNone(yield* approvals.consumeMatching(taskId, PUSH))).toBe(true)
    }).pipe(Effect.provide(layer)),
  )

  it.effect("two approvals for the same action are used one at a time", () =>
    Effect.gen(function* () {
      const approvals = yield* Approvals
      const taskId = yield* seedTask
      yield* approved(taskId, PUSH)
      yield* approved(taskId, PUSH)
      expect(Option.isSome(yield* approvals.consumeMatching(taskId, PUSH))).toBe(true)
      expect(Option.isSome(yield* approvals.consumeMatching(taskId, PUSH))).toBe(true)
      expect(Option.isNone(yield* approvals.consumeMatching(taskId, PUSH))).toBe(true)
    }).pipe(Effect.provide(layer)),
  )
})

describe("Approvals.consumeMatching, hard cases", () => {
  it.effect("two concurrent calls for one approval: exactly one gets it", () =>
    Effect.gen(function* () {
      const approvals = yield* Approvals
      const taskId = yield* seedTask
      yield* approved(taskId, PUSH)
      const results = yield* Effect.all(
        [approvals.consumeMatching(taskId, PUSH), approvals.consumeMatching(taskId, PUSH)],
        { concurrency: 2 },
      )
      expect(results.filter(Option.isSome)).toHaveLength(1)
    }).pipe(Effect.provide(layer)),
  )

  it.effect("an expired request never gives a permission, even if someone approves it late", () =>
    Effect.gen(function* () {
      const approvals = yield* Approvals
      const taskId = yield* seedTask
      const record = yield* approvals.request({ taskId, botId: BOT, action: PUSH, risk: "irreversible" })
      yield* TestClock.adjust(Duration.millis(APPROVAL_TTL_MS + 1))
      yield* approvals.expireDue()
      yield* approvals.resolve(record.id, "approved", "user:web")
      expect((yield* approvals.get(record.id)).status).toBe("expired")
      expect(Option.isNone(yield* approvals.consumeMatching(taskId, PUSH))).toBe(true)
    }).pipe(Effect.provide(layer)),
  )
})

const hash = (tool: string, input: unknown): string => actionHashOf({ tool, input })

describe("actionHashOf", () => {
  it("does not confuse a tool with a newline and an input with another tool and input", () => {
    expect(hash("Bash\nls", "x")).not.toBe(hash("Bash", "ls\nx"))
    expect(hash("Bash", "ls")).not.toBe(hash("Bash\n", "ls"))
    expect(hash("A", "B\nC")).not.toBe(hash("A\nB", "C"))
  })

  it("keeps a string input apart from an object or array input that prints the same", () => {
    expect(hash("Bash", '{"command":"ls"}')).not.toBe(hash("Bash", { command: "ls" }))
    expect(hash("Bash", "[1]")).not.toBe(hash("Bash", [1]))
    expect(hash("Bash", "null")).not.toBe(hash("Bash", null))
  })

  it("is stable for key order at any depth, including objects inside arrays", () => {
    expect(
      hash("T", {
        b: [
          { y: 1, x: 2 },
          { d: 1, c: 2 },
        ],
        a: { n: 1, m: 2 },
      }),
    ).toBe(
      hash("T", {
        a: { m: 2, n: 1 },
        b: [
          { x: 2, y: 1 },
          { c: 2, d: 1 },
        ],
      }),
    )
  })

  it("keeps array order and nested arrays significant", () => {
    expect(hash("T", [1, [2, 3]])).not.toBe(hash("T", [[2, 3], 1]))
    expect(hash("T", [[1, 2], [3]])).not.toBe(hash("T", [[1], [2, 3]]))
  })

  it("reads numbers by value: -0 is 0 and 1e3 is 1000, but 1 is not '1'", () => {
    expect(hash("T", { n: -0 })).toBe(hash("T", { n: 0 }))
    expect(hash("T", { n: 1e3 })).toBe(hash("T", { n: 1000 }))
    expect(hash("T", { n: 1 })).not.toBe(hash("T", { n: "1" }))
  })

  it("keeps unicode exact: composed and decomposed forms are different inputs, and key order is by code unit", () => {
    expect(hash("T", { name: "\u00e9" })).not.toBe(hash("T", { name: "e\u0301" }))
    expect(hash("T", { "\u00e9": 1, z: 2 })).toBe(hash("T", { z: 2, "\u00e9": 1 }))
    expect(hash("T", { "\u{1F600}": 1 })).toBe(hash("T", { "\u{1F600}": 1 }))
  })
})
