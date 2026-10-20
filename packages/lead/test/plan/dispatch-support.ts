import { Beacon, BeaconLive } from "@shoalwork/beacon"
import { BotRegistry, BotRegistryLive } from "@shoalwork/bots"
import {
  type Artifact,
  type BotId,
  newPlanId,
  newStepId,
  newTaskId,
  type Plan,
  type Step,
  type StepId,
  type TaskId,
  type TaskSpec,
  type Verdict,
} from "@shoalwork/contracts"
import { withTempDb } from "@shoalwork/db/testing"
import { Deferred, Effect, Layer, Ref } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { makeDispatcher, type StepResult } from "../../src/plan/dispatcher.js"
import {
  IntegrationFailed,
  type IntegrationSession,
  type MergeOutcome,
  type StepBranch,
} from "../../src/plan/integration.js"
import { makeTaskStore } from "../../src/tasks.js"
import { createBot, specFor } from "../support.js"

export const DispatchLayer = Layer.provideMerge(BotRegistryLive, Layer.provideMerge(BeaconLive, withTempDb()))

export const step = (title: string, dependsOn: ReadonlyArray<StepId> = []): Step => ({
  id: newStepId(),
  title,
  prompt: `Do ${title}.`,
  dependsOn,
  acceptance: [`${title} works`],
  budget: { tokens: 1000, seconds: 5, usd: 0.01 },
  tier: "light",
  parallelizable: true,
})

export const okVerdict = (branch?: string): Verdict => ({
  kind: "ok",
  summary: "done",
  evidence: branch === undefined ? [] : [branch],
  cost: { tokensIn: 0, tokensOut: 0, usd: 0, seconds: 0 },
})

export const conflictVerdict = (files: ReadonlyArray<string>): Verdict => ({
  kind: "failed",
  summary: `delivery failed at conflict: rebase conflict in ${files.length} file(s)`,
  evidence: ["delivery: conflict", ...files.map((file) => `conflict file: ${file}`)],
  cost: { tokensIn: 0, tokensOut: 0, usd: 0, seconds: 0 },
})

export const stoppedResult = (): StepResult => ({
  verdict: {
    kind: "blocked",
    summary: "stopped by test",
    evidence: ["stopped by test"],
    cost: { tokensIn: 0, tokensOut: 0, usd: 0, seconds: 0 },
  },
  stopped: true,
})

export const failedVerdict = (): Verdict => ({
  kind: "failed",
  summary: "tests failed",
  evidence: [],
  cost: { tokensIn: 0, tokensOut: 0, usd: 0, seconds: 0 },
})

// What a fake run sees: the step its task belongs to, the task spec and the number of runs of that step so far.
export interface FakeRun {
  readonly step: Step
  readonly spec: TaskSpec
  readonly taskId: TaskId
  readonly nth: number
}

export interface FakeIntegration {
  readonly merges: Array<string>
  readonly published: Array<string>
  readonly prs: Array<string>
  readonly opened: Array<TaskSpec>
  readonly session: IntegrationSession
}

// A plan branch that records what it was asked to do. `merge` decides each outcome; merges never overlap in time.
export interface IntegrationFaults {
  readonly failMerge?: (title: string) => boolean
  readonly failPublish?: boolean
  readonly failPr?: boolean
}

export const fakeIntegration = (
  merge: (step: StepBranch, nth: number) => MergeOutcome = () => ({
    _tag: "Merged",
    serialized: false,
    overlap: [],
  }),
  faults: IntegrationFaults = {},
): Effect.Effect<FakeIntegration> =>
  Effect.gen(function* () {
    const merges: Array<string> = []
    const published: Array<string> = []
    const prs: Array<string> = []
    const counts = new Map<StepId, number>()
    let publishedNow = false
    let inFlight = 0
    const session: IntegrationSession = {
      branch: "plan/abc123",
      merge: (stepBranch) =>
        Effect.gen(function* () {
          inFlight += 1
          if (inFlight > 1) {
            return yield* Effect.fail(new IntegrationFailed({ op: "merge", cause: "merges overlapped" }))
          }
          yield* Effect.yieldNow
          if (faults.failMerge?.(stepBranch.title) === true) {
            inFlight -= 1
            return yield* Effect.fail(new IntegrationFailed({ op: "merge", cause: "disk full" }))
          }
          const nth = (counts.get(stepBranch.stepId) ?? 0) + 1
          counts.set(stepBranch.stepId, nth)
          merges.push(stepBranch.title)
          inFlight -= 1
          return merge(stepBranch, nth)
        }),
      publish:
        faults.failPublish === true
          ? Effect.fail(new IntegrationFailed({ op: "push", cause: "rejected" }))
          : Effect.sync(() => {
              publishedNow = true
              published.push("plan/abc123")
            }),
      isPublished: Effect.sync(() => publishedNow),
      openPr:
        faults.failPr === true
          ? Effect.fail(new IntegrationFailed({ op: "pr", cause: "gh unavailable" }))
          : Effect.sync((): Artifact => {
              prs.push("plan/abc123")
              return { kind: "pr", ref: "https://github.com/renzer83/shoalwork-sandbox/pull/9" }
            }),
    }
    return { merges, published, prs, opened: [], session }
  })

export const setupDispatch = (
  steps: ReadonlyArray<Step>,
  options: {
    readonly rootOver?: Partial<Omit<TaskSpec, "id">>
    readonly concurrency?: number
    readonly integration: FakeIntegration
    readonly run: (run: FakeRun) => Effect.Effect<Verdict | StepResult>
    readonly overBudget?: (botId: BotId) => boolean
    readonly owners?: (id: StepId) => BotId | undefined
  },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const beacon = yield* Beacon
    const tasks = makeTaskStore(sql)
    const bots = yield* BotRegistry
    const bot = yield* createBot
    const root: TaskSpec = {
      ...specFor(bot, {
        kind: "code",
        repo: { url: "https://github.com/renzer83/shoalwork-sandbox", base: "main" },
        ...options.rootOver,
      }),
      id: newTaskId(),
    }
    yield* tasks.insert(root)
    const plan: Plan = { id: newPlanId(), taskId: root.id, steps }
    const assignments = new Map<StepId, BotId>(steps.map((s) => [s.id, options.owners?.(s.id) ?? bot.id]))
    const specs: Array<TaskSpec> = []
    const abandoned: Array<TaskId> = []
    const runs = new Map<StepId, number>()
    const dispatcher = makeDispatcher({
      sql,
      beacon,
      tasks,
      concurrency: options.concurrency ?? 3,
      integration: {
        open: (spec) =>
          Effect.sync(() => {
            options.integration.opened.push(spec)
            return options.integration.session
          }),
      },
      overBudget: (botId) => Effect.succeed(options.overBudget?.(botId) ?? false),
      abandon: (id) => Effect.sync(() => void abandoned.push(id)),
      runTask: (taskId) =>
        Effect.gen(function* () {
          const record = yield* tasks.get(taskId).pipe(Effect.orDie)
          specs.push(record.spec)
          const parent = record.spec.parent
          const found = steps.find(
            (s) => parent !== undefined && "stepId" in parent && s.id === parent.stepId,
          )
          if (found === undefined) return yield* Effect.die("task without a plan step")
          const nth = (runs.get(found.id) ?? 0) + 1
          runs.set(found.id, nth)
          const result = yield* options.run({ step: found, spec: record.spec, taskId, nth })
          return "verdict" in result ? result : { verdict: result, stopped: false }
        }),
    })
    return { dispatcher, plan, assignments, specs, abandoned, root, tasks, bot, bots }
  })

// Counts how many fake runs are inside `body` at once and remembers the highest count.
export const gauge = Effect.gen(function* () {
  const current = yield* Ref.make(0)
  const peak = yield* Ref.make(0)
  const track = <A, E, R>(body: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Ref.updateAndGet(current, (n) => n + 1).pipe(
        Effect.tap((n) => Ref.update(peak, (p) => Math.max(p, n))),
      ),
      () => body,
      () => Ref.update(current, (n) => n - 1),
    )
  return { track, peak: Ref.get(peak) }
})

export { Deferred }
