import { Beacon, BeaconLive } from "@shoalwork/beacon"
import { BotRegistry, BotRegistryLive } from "@shoalwork/bots"
import {
  type Bot,
  type BotId,
  NewBot,
  newPlanId,
  newStepId,
  newTaskId,
  type Plan,
  type Step,
  type StepId,
  type TaskId,
  type TaskSpec,
} from "@shoalwork/contracts"
import { withTempDb } from "@shoalwork/db/testing"
import { Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { ChatFailure } from "../src/chat.js"
import { makePods, type PodTopicPort } from "../src/pods.js"
import { makeTaskStore, type TaskStoreShape } from "../src/tasks.js"
import { specFor } from "./support.js"

// Real SQLite (migrations applied), the real Beacon and the Bot registry.
export const PodLayer = Layer.provideMerge(BotRegistryLive, Layer.provideMerge(BeaconLive, withTempDb()))

const WORKER_DEF = Schema.decodeUnknownSync(NewBot)({
  name: "worker-bot",
  role: "developer",
  kind: "fixed",
  instructions: "Do the work you are given.",
  executors: { preferred: "claude-code", allowed: ["claude-code"] },
  modelTiers: {},
  connectors: [],
  budget: { tokens: 500000, seconds: 1800, usd: 5 },
  policy: "default",
  tank: { mode: "local", host: "mac" },
  memory: { scope: "bot" },
})

const LEAD_DEF = Schema.decodeUnknownSync(NewBot)({
  name: "lead",
  role: "lead",
  kind: "fixed",
  instructions: "Plan and deliver.",
  executors: { preferred: "claude-code", allowed: ["claude-code"] },
  modelTiers: {},
  connectors: [],
  budget: { tokens: 500000, seconds: 1800, usd: 5 },
  policy: "default",
  tank: { mode: "local", host: "mac" },
  memory: { scope: "bot" },
})

// A topic port that records what it was asked to do, and hands out thread ids from 100.
export const fakeTopic = (options: { readonly failOpen?: boolean } = {}) => {
  const opened: Array<string> = []
  const posts: Array<{ readonly threadId: number; readonly text: string }> = []
  let next = 100
  const port: PodTopicPort = {
    open: (name) =>
      options.failOpen === true
        ? Effect.fail(new Error("topic refused"))
        : Effect.sync(() => {
            opened.push(name)
            next += 1
            return next
          }),
    post: (threadId, text) => Effect.sync(() => void posts.push({ threadId, text })),
  }
  return { port, opened, posts }
}

export interface ScriptedAsk {
  readonly prompts: Array<string>
  readonly ask: (botId: BotId, prompt: string) => Effect.Effect<string, ChatFailure>
}

// Replies in order; a ChatFailure entry fails that call. The last reply repeats.
export const scriptedAsk = (replies: ReadonlyArray<string | ChatFailure>): ScriptedAsk => {
  const prompts: Array<string> = []
  return {
    prompts,
    ask: (_botId, prompt) => {
      const next = replies[prompts.length] ?? replies[replies.length - 1] ?? ""
      prompts.push(prompt)
      return typeof next === "string" ? Effect.succeed(next) : Effect.fail(next)
    },
  }
}

export const failure = (message: string): ChatFailure => new ChatFailure({ reason: "error", message })

export const setupPods = (
  replies: ReadonlyArray<string | ChatFailure>,
  options: { failOpen?: boolean } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const beacon = yield* Beacon
    const bots = yield* BotRegistry
    const tasks: TaskStoreShape = makeTaskStore(sql)
    const lead: Bot = yield* bots.upsert(LEAD_DEF, "test")
    // A fixed owner: the shared createBot helper is an auxiliary, and closing counts only auxiliaries.
    const worker: Bot = yield* bots.upsert(WORKER_DEF, "test")
    const topic = fakeTopic(options)
    const script = scriptedAsk(replies)
    const resumes: Array<{ readonly taskId: TaskId; readonly message: unknown }> = []
    const remembered: Array<{ readonly podId: string; readonly summary: string }> = []
    const pods = makePods({
      sql,
      beacon,
      tasks,
      bots,
      topic: topic.port,
      ask: script.ask,
      resume: (taskId, message) => Effect.sync(() => void resumes.push({ taskId, message })),
      remember: (podId, summary) => Effect.sync(() => void remembered.push({ podId, summary })),
    })
    // A two-step plan: step one has the worker as owner, step two is for a new auxiliary Bot.
    const taskId = newTaskId()
    const planTask: TaskSpec = { ...specFor(lead, { kind: "code" }), id: taskId }
    yield* tasks.insert(planTask)
    const stepOwned = newStepId()
    const stepNew = newStepId()
    const plan: Plan = {
      id: newPlanId(),
      taskId,
      steps: [stepOf(stepOwned, "Owned step", worker.id), stepOf(stepNew, "New step", undefined)],
    }
    // The planner stores the plan before a Pod opens; the Pod finds its plan through this row.
    yield* sql`INSERT INTO plans (id, task_id, plan, state, created_at)
      VALUES (${plan.id}, ${taskId}, ${JSON.stringify(plan)}, 'ready', ${new Date().toISOString()})`
    return {
      sql,
      beacon,
      bots,
      tasks,
      lead,
      worker,
      topic,
      script,
      pods,
      plan,
      stepOwned,
      stepNew,
      resumes,
      remembered,
    }
  })

export const stepOf = (id: StepId, title: string, assignedBot: BotId | undefined): Step => ({
  id,
  title,
  prompt: `Do: ${title}.`,
  dependsOn: [],
  acceptance: [`${title} is done`],
  kind: "work" as const,
  checks: [],
  budget: { tokens: 1000, seconds: 60, usd: 0.1 },
  tier: "light" as const,
  parallelizable: true,
  ...(assignedBot === undefined ? {} : { assignedBot }),
})

export const botNamed = (bots: ReadonlyArray<Bot & { readonly state: string }>, name: string) =>
  bots.find((bot) => bot.name === name)

// The tag of the typed error an Effect.result carries (undefined for a success).
export const failedTag = (result: {
  readonly _tag: string
  readonly failure?: unknown
}): string | undefined =>
  result._tag === "Failure" &&
  typeof result.failure === "object" &&
  result.failure !== null &&
  "_tag" in result.failure
    ? String(result.failure._tag)
    : undefined
