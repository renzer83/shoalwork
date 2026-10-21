import { Beacon } from "@shoalwork/beacon"
import { BotRegistry } from "@shoalwork/bots"
import { type ExecutorEvent, NewBot, streamIds, type TaskId } from "@shoalwork/contracts"
import { Effect, Schema, Stream } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { makeReplay, replayFromServices } from "../src/index.js"
import { Lead, NEW_BOT } from "./support.js"

export const SHA = "0123456789abcdef0123456789abcdef01234567"
export const OTHER_SHA = "fedcba9876543210fedcba9876543210fedcba98"

// A bot that may use both executors of the tests.
export const TWO_EXECUTORS_BOT = Schema.decodeUnknownSync(NewBot)({
  ...Schema.encodeSync(NewBot)(NEW_BOT),
  executors: { preferred: "claude-code", allowed: ["claude-code", "codex"] },
})

export const createTwoExecutorsBot = Effect.gen(function* () {
  return yield* (yield* BotRegistry).upsert(TWO_EXECUTORS_BOT, "test")
})

export const edit = (path: string): ExecutorEvent => ({ kind: "file_edit", path })

export const streamEvents = (taskId: TaskId) =>
  Effect.gen(function* () {
    const beacon = yield* Beacon
    return Array.from(yield* Stream.runCollect(beacon.readStream(streamIds.task(taskId), 0)))
  })

export const replayRows = Effect.gen(function* () {
  const sql = yield* SqlClient
  return yield* sql<{
    readonly id: string
    readonly source_task_id: string
    readonly new_task_id: string
    readonly overrides: string
    readonly base_sha: string | null
    readonly context_frozen: number
  }>`SELECT * FROM replays`
})

export const replay = Effect.gen(function* () {
  return yield* replayFromServices
})

export { Lead, makeReplay }
