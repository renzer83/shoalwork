import { Beacon, BeaconTest } from "@shoalwork/beacon"
import { BotRegistry, BotRegistryLive } from "@shoalwork/bots"
import {
  type ExecutorId,
  NewBot,
  type PolicyEffect,
  streamIds,
  type TaskId,
  TaskId as TaskIdSchema,
} from "@shoalwork/contracts"
import { GhClientTest } from "@shoalwork/currents"
import { nowIso } from "@shoalwork/db"
import { withTempDb } from "@shoalwork/db/testing"
import { Effect, Layer, Schema, Stream } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { cycleOf } from "../src/cycle-rows.js"
import { Kanban } from "../src/kanban.js"
import { KanbanLive } from "../src/kanban-live.js"
import { makeScheduler } from "../src/scheduler.js"
import { CLAUDE, makeApprovals, makeFakeLead } from "./cycle-fakes.js"

export { CLAUDE, CODEX } from "./cycle-fakes.js"

export const PROJECT = "demo"
export const REPO = "acme/demo"
export const BRANCH = "bot/demo/1"
export const PR_URL = `https://github.com/${REPO}/pull/7`
export const GATES = ["pnpm typecheck", "pnpm test"]
export const E2E = ["pnpm e2e"]

const botDefinition = (name: string) =>
  Schema.decodeUnknownSync(NewBot)({
    name,
    role: name.split("-")[0],
    kind: "auxiliary",
    instructions: "Do the work you are given.",
    executors: { preferred: "claude-code", allowed: ["claude-code", "codex"] },
    modelTiers: {},
    connectors: [],
    budget: { tokens: 500000, seconds: 1800, usd: 5 },
    policy: "default",
    tank: { mode: "local", host: "mac" },
    memory: { scope: "bot" },
  })

// The whole scene of a cycle test: a project on the board with its three Bots, a Lead that stores tasks, GitHub
// that records its calls, a policy whose answer the test chooses and an approval flow that waits for the test.
export const makeScene = (
  options: {
    readonly maxInProgress?: number
    readonly autoMerge?: boolean
    readonly e2e?: ReadonlyArray<string>
    readonly policy?: PolicyEffect | "none"
    // What the policy answers for the reviewer Bot (default: the same as for everyone).
    readonly reviewerPolicy?: PolicyEffect
    readonly withApprovals?: boolean
  } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const beacon = yield* Beacon
    const kanban = yield* Kanban
    const registry = yield* BotRegistry
    const worker = yield* registry.upsert(botDefinition(`worker-${PROJECT}`), "test")
    const testpilot = yield* registry.upsert(botDefinition(`testpilot-${PROJECT}`), "test")
    const reviewer = yield* registry.upsert(botDefinition(`reviewer-${PROJECT}`), "test")
    yield* kanban.addProject({
      slug: PROJECT,
      name: "Demo",
      repoUrl: `https://github.com/${REPO}`,
      defaultBranch: "main",
      maxInProgress: options.maxInProgress ?? 3,
      gates: GATES,
      e2e: options.e2e ?? E2E,
      autoMerge: options.autoMerge ?? true,
    })

    const fake = makeFakeLead(beacon)
    const gh = GhClientTest()
    const pr = { state: "OPEN", checks: "pass" as "pass" | "fail" | "pending" }
    const ghShape = {
      ...gh.shape,
      prView: (repo: string, n: number) => {
        gh.calls.push({ method: "prView", args: [repo, n] })
        return Effect.succeed({ state: pr.state, mergeable: "MERGEABLE", headRef: BRANCH })
      },
      prChecks: (repo: string, n: number, o: { watch: boolean; timeoutMs: number }) => {
        gh.calls.push({ method: "prChecks", args: [repo, n, o] })
        return Effect.succeed(pr.checks)
      },
    }
    const decision: { effect: PolicyEffect } = {
      effect: options.policy === undefined || options.policy === "none" ? "allow" : options.policy,
    }
    const policyCalls: Array<string> = []
    const policy =
      options.policy === "none"
        ? undefined
        : {
            evaluate: (botId: string) => {
              policyCalls.push(botId)
              const effect =
                botId === reviewer.id ? (options.reviewerPolicy ?? decision.effect) : decision.effect
              return Effect.succeed({ effect, risk: "external" } as const)
            },
          }
    const approvals = makeApprovals()
    const scheduler = makeScheduler({
      sql,
      beacon,
      kanban,
      lead: fake.lead,
      bots: registry,
      gh: ghShape,
      policy,
      ...(options.withApprovals === false ? {} : { approvals: approvals.approvals }),
    })

    let passes = 0
    const pass = Effect.gen(function* () {
      passes += 1
      yield* scheduler.reconcile(PROJECT)
    })

    let issue = 0
    const addIssue = (state = "ready", updatedAt: string | null = null) =>
      Effect.gen(function* () {
        issue += 1
        const id = `ptask_${issue}`
        yield* sql`INSERT INTO project_tasks
          (id, project, title, issue_number, pr_number, state, created_at, retries, manual_interventions, branch, version, updated_at, source)
          VALUES (${id}, ${PROJECT}, ${`issue ${issue}`}, ${issue}, ${null}, ${state}, ${nowIso()}, 0, 0, ${null}, 0, ${updatedAt}, 'board')`
        return id
      })

    const stateOf = (id: string) =>
      Effect.gen(function* () {
        const tasks = yield* kanban.listTasks(PROJECT)
        return tasks.find((task) => task.id === id)?.state
      })

    const phaseOf = (id: string) =>
      Effect.gen(function* () {
        return (yield* cycleOf(sql, PROJECT, id))?.phase
      })

    const currentOf = (id: string) =>
      Effect.gen(function* () {
        const cycle = yield* cycleOf(sql, PROJECT, id)
        if (cycle === undefined || cycle.currentTaskId === null) return yield* Effect.die("no current task")
        return Schema.decodeUnknownSync(TaskIdSchema)(cycle.currentTaskId)
      })

    // A CI result as the webhook records it. The checks of the pull request follow the result unless the test says
    // otherwise (a result is only a hint; the checks decide).
    const ci = (conclusion: string, branch = BRANCH, checks?: "pass" | "fail" | "pending") => {
      if (checks !== undefined) pr.checks = checks
      else if (conclusion === "success") pr.checks = "pass"
      else if (conclusion !== "cancelled") pr.checks = "fail"
      return beacon.append({
        streamId: streamIds.system,
        type: "github.workflow_run",
        payload: {
          deliveryId: `d_${crypto.randomUUID()}`,
          repo: REPO,
          action: "completed",
          sender: "ci",
          url: "https://github.com/x",
          botAuthored: false,
          headBranch: branch,
          conclusion,
        },
        actor: "github",
        correlationId: "ci",
      })
    }

    // The worker opened a pull request: the verdict names it, and its executor is on record.
    const workerDone = (id: TaskId, executor: ExecutorId = CLAUDE) =>
      fake.finish(id, { executor, result: "opened", evidence: [PR_URL] })

    return {
      sql,
      beacon,
      kanban,
      scheduler,
      fake,
      gh,
      pr,
      decision,
      policyCalls,
      approvals,
      bots: { worker, testpilot, reviewer },
      pass,
      passes: () => passes,
      addIssue,
      stateOf,
      phaseOf,
      currentOf,
      ci,
      workerDone,
    }
  })

export type Scene = Effect.Success<ReturnType<typeof makeScene>>

export const TestLayer = Layer.provideMerge(
  Layer.mergeAll(KanbanLive, BotRegistryLive),
  Layer.provideMerge(BeaconTest, withTempDb()),
)

// Drives a task from `ready` to a worker with a pull request and a green CI: the cycle waits for the testpilot.
export const toE2e = (scene: Scene, id: string) =>
  Effect.gen(function* () {
    yield* scene.pass
    yield* scene.workerDone(yield* scene.currentOf(id))
    yield* scene.pass
    yield* scene.ci("success")
    yield* scene.pass
  })

// From the testpilot to the reviewer's task, with the testpilot green.
export const toReview = (scene: Scene, id: string) =>
  Effect.gen(function* () {
    yield* toE2e(scene, id)
    yield* scene.fake.finish(yield* scene.currentOf(id), { executor: CLAUDE, result: "all green" })
    yield* scene.pass
  })

export const mergeCalls = (scene: Scene) => scene.gh.calls.filter((call) => call.method === "prMerge")

export const errorsOf = (scene: Scene) =>
  Effect.gen(function* () {
    const events = Array.from(yield* Stream.runCollect(scene.beacon.readStream(streamIds.project("demo"))))
    return events.filter((event) => event.type === "error.raised")
  })
