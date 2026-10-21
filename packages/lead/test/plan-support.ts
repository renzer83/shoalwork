import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Beacon, BeaconLive } from "@shoalwork/beacon"
import { BotRegistry, BotRegistryLive, type BotRegistryShape } from "@shoalwork/bots"
import { type BotId, newTaskId, streamIds, type TaskSpec } from "@shoalwork/contracts"
import { withTempDb } from "@shoalwork/db/testing"
import { Effect, Layer, Stream } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { ChatFailure } from "../src/chat.js"
import { makePlanner } from "../src/plan/planner.js"
import { makeTaskStore, type TaskStoreShape } from "../src/tasks.js"
import { createBot, specFor } from "./support.js"

export const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, "fixtures", "plans", `${name}.json`), "utf8")

// Real SQLite (migrations applied), the real Beacon (it validates every payload) and the Bot registry.
export const TestLayer = Layer.provideMerge(BotRegistryLive, Layer.provideMerge(BeaconLive, withTempDb()))

// A reply of the script: text, a failed ask, a defect inside the ask, or an ask that never answers.
export type Reply = string | ChatFailure | { readonly die: string } | { readonly hang: true }

// A heavy tier that answers from a script, one reply per ask, and remembers every prompt it received.
const scripted = (replies: ReadonlyArray<Reply>) => {
  const prompts: Array<string> = []
  const notes: Array<string> = []
  const origins: Array<TaskSpec["origin"]> = []
  return {
    prompts,
    notes,
    origins,
    ask: (_botId: BotId, prompt: string) => {
      const next = replies[prompts.length] ?? replies[replies.length - 1] ?? ""
      prompts.push(prompt)
      if (typeof next === "string") return Effect.succeed(next)
      if ("die" in next) return Effect.die(next.die)
      if ("hang" in next) return Effect.never
      return Effect.fail(next)
    },
    notify: (_botId: BotId, text: string, task: Pick<TaskSpec, "origin">) =>
      Effect.sync(() => {
        notes.push(text)
        origins.push(task.origin)
      }),
  }
}

export interface SetupOptions {
  // Wrap what the planner uses, e.g. to make some writes or reads fail.
  readonly wrapStore?: (real: TaskStoreShape) => TaskStoreShape
  readonly wrapBots?: (real: BotRegistryShape) => BotRegistryShape
}

export const setup = (
  replies: ReadonlyArray<Reply>,
  over: Partial<Omit<TaskSpec, "id">> = {},
  options: SetupOptions = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const beacon = yield* Beacon
    const bots = yield* BotRegistry
    const tasks = makeTaskStore(sql)
    const bot = yield* createBot
    const script = scripted(replies)
    const planner = makePlanner({
      sql,
      beacon,
      tasks: (options.wrapStore ?? ((real) => real))(tasks),
      bots: (options.wrapBots ?? ((real) => real))(bots),
      ask: script.ask,
      executors: ["claude-code", "codex"],
      notify: script.notify,
    })
    const task: TaskSpec = {
      ...specFor(bot, { kind: "code", acceptance: ["a", "b", "c"], ...over }),
      id: newTaskId(),
    }
    yield* tasks.insert(task)
    const rows = () =>
      sql<{ readonly id: string; readonly plan: string; readonly state: string }>`
        SELECT id, plan, state FROM plans WHERE task_id = ${task.id}`
    const events = () =>
      Effect.map(Stream.runCollect(beacon.readStream(streamIds.task(task.id))), (all) =>
        all.map((event) => ({ type: event.type, payload: event.payload })),
      )
    return { planner, task, tasks, script, rows, events, bot, beacon, sql, bots }
  })

export const stepJson = (ref: string, over: Record<string, unknown> = {}) => ({
  ref,
  title: `Step ${ref}`,
  prompt: `Do step ${ref}.`,
  dependsOn: [],
  acceptance: [`step ${ref} is done`],
  checks: [{ argv: ["pnpm", "test"] }],
  budget: { tokens: 1000, seconds: 5, usd: 0.01 },
  tier: "light",
  parallelizable: true,
  assignedBot: "worker-bot",
  ...over,
})
export const planJson = (steps: ReadonlyArray<unknown>): string => JSON.stringify({ steps })
