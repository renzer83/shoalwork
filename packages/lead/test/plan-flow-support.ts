import { Beacon } from "@shoalwork/beacon"
import {
  newPlanId,
  newStepId,
  newTaskId,
  type Plan,
  type TaskId,
  type TaskSpec,
  type Verdict,
} from "@shoalwork/contracts"
import { Deferred, Effect, type Scope } from "effect"
import { makeDispatcher, type StepResult } from "../src/plan/dispatcher.js"
import type { IntegrationFailed, IntegrationSession } from "../src/plan/integration.js"
import type { PlanOutcome, PlanSignals } from "../src/plan/planner.js"
import { makePlanFlow } from "../src/plan-flow.js"
import type { TaskRecord } from "../src/tasks.js"
import { fakeIntegration, okVerdict, verified } from "./plan/dispatch-support.js"
import { type setupPods, stepOf } from "./pods-support.js"
import { specFor } from "./support.js"

export const REPO = { url: "https://github.com/renzer83/shoalwork-sandbox", base: "main" }

type Setup = Effect.Success<ReturnType<typeof setupPods>>

export interface HarnessOptions {
  // The Bot that owns the root task (default: the lead).
  readonly rootBot?: "lead" | "worker"
  readonly rootOver?: Partial<Omit<TaskSpec, "id">>
  readonly signals?: PlanSignals
  // What running a step task comes to (default: ok, and the task is marked done).
  readonly runStep?: (record: TaskRecord, s: Setup) => Effect.Effect<StepResult>
  readonly open?: Effect.Effect<IntegrationSession, IntegrationFailed, Scope.Scope>
  readonly planner?: (root: TaskSpec, plan: Plan, s: Setup) => Effect.Effect<PlanOutcome>
}

// A root task with a three-step plan (A and B owned by the worker, C a new auxiliary that needs both), real Pods and
// a real dispatcher over fake step runs and a fake plan branch. Nothing here depends on the clock.
export const harness = (s: Setup, options: HarnessOptions = {}) =>
  Effect.gen(function* () {
    const beacon = yield* Beacon
    const rootBot = options.rootBot === "worker" ? s.worker : s.lead
    const root: TaskSpec = {
      ...specFor(rootBot, { repo: REPO, ...options.rootOver }),
      id: newTaskId(),
    }
    yield* s.tasks.insert(root)
    const a = stepOf(newStepId(), "Step A", s.worker.id)
    const b = stepOf(newStepId(), "Step B", s.worker.id)
    const c = { ...stepOf(newStepId(), "Step C", undefined), dependsOn: [a.id, b.id] }
    const plan: Plan = { id: newPlanId(), taskId: root.id, steps: [a, b, c] }
    // What the real planner does when it succeeds: the plan stored with the task ready.
    const store = Effect.gen(function* () {
      yield* s.sql`INSERT INTO plans (id, task_id, plan, state, created_at)
        VALUES (${plan.id}, ${root.id}, ${JSON.stringify(plan)}, 'ready', ${new Date().toISOString()})`
      yield* s.tasks.update(root.id, { state: "ready" })
    })
    const integration = yield* fakeIntegration()
    const stop = yield* Deferred.make<string>()
    const ordinary: Array<TaskId> = []
    const abandoned: Array<TaskId> = []
    const done = (record: TaskRecord): Effect.Effect<StepResult> =>
      Effect.gen(function* () {
        const verdict: Verdict = okVerdict(`bot/x/${record.spec.id}`)
        yield* s.tasks.update(record.spec.id, { state: "done", verdict }).pipe(Effect.orDie)
        return { verdict, stopped: false }
      })
    const dispatcher = makeDispatcher({
      verify: () => Effect.succeed(verified("ok")),
      sql: s.sql,
      beacon,
      tasks: s.tasks,
      concurrency: 3,
      integration: { open: () => options.open ?? Effect.succeed(integration.session) },
      overBudget: () => Effect.succeed(false),
      abandon: (id) => Effect.sync(() => void abandoned.push(id)),
      runTask: (taskId) =>
        Effect.gen(function* () {
          const record = yield* s.tasks.get(taskId).pipe(Effect.orDie)
          return yield* options.runStep === undefined ? done(record) : options.runStep(record, s)
        }),
    })
    const flow = makePlanFlow({
      sql: s.sql,
      beacon,
      tasks: s.tasks,
      bots: s.bots,
      control: {
        track: () =>
          Effect.succeed({ stopRequested: Deferred.await(stop), isStopped: Deferred.isDone(stop) }),
      },
      planner: {
        plan: (task) =>
          options.planner?.(task, plan, s) ??
          store.pipe(Effect.orDie, Effect.as({ kind: "planned", plan, warnings: [] } satisfies PlanOutcome)),
      },
      pods: s.pods,
      dispatcher,
      signalsOf: () => Effect.succeed(options.signals ?? { complexity: 4 }),
      runTask: (id) =>
        Effect.sync(() => {
          ordinary.push(id)
          return { verdict: okVerdict(), recorded: true, stopped: false }
        }),
    })
    return { s, beacon, root, plan, store, flow, integration, stop, ordinary, abandoned, dispatcher }
  })

export const podStates = (s: Setup, taskId: TaskId) =>
  s.sql<{ readonly state: string }>`SELECT state FROM pods WHERE task_id = ${taskId}`.pipe(
    Effect.map((rows) => rows.map((row) => row.state)),
  )
