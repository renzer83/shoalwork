import type { BeaconShape } from "@shoalwork/beacon"
import type { BotRegistryShape } from "@shoalwork/bots"
import { type Bot, type BotId, type NotFound, Plan, type TaskSpec, type Verdict } from "@shoalwork/contracts"
import { nowIso } from "@shoalwork/db"
import { Cause, Effect, Schema } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import { usableExecutors } from "../bot-proposal.js"
import type { ChatFailure } from "../chat.js"
import { makeLifecycle } from "../lifecycle.js"
import type { TaskStoreShape } from "../tasks.js"
import { blockedVerdict, clip, describeFailure } from "../verdict.js"
import { buildReviewPrompt } from "../verify/review.js"
import { checkDraft, NEW_BOT } from "./check.js"
import { buildPlanPrompt } from "./prompt.js"
import { readDraft } from "./reply.js"

// What the Reflex decided about the task; absent means unknown.
export interface PlanSignals {
  readonly complexity?: number
  readonly parallelizable?: boolean
}

export const COMPLEXITY_THRESHOLD = 3
export const ACCEPTANCE_THRESHOLD = 2

// A task is planned when it is complex, the Reflex says it splits in parallel, or it is code with many criteria.
export const shouldPlan = (task: Pick<TaskSpec, "kind" | "acceptance">, signals: PlanSignals = {}): boolean =>
  (signals.complexity ?? 0) >= COMPLEXITY_THRESHOLD ||
  signals.parallelizable === true ||
  (task.kind === "code" && task.acceptance.length > ACCEPTANCE_THRESHOLD)

export interface PlannerDeps {
  readonly sql: SqlClient
  readonly beacon: BeaconShape
  readonly tasks: TaskStoreShape
  readonly bots: BotRegistryShape
  // One prompt in, the model's text out, on the heavy tier of the task's Bot (the composition root binds chat.heavy).
  readonly ask: (botId: BotId, prompt: string) => Effect.Effect<string, ChatFailure>
  // Executors known to the registry (the chat executor is filtered out).
  readonly executors: ReadonlyArray<string>
  // A message to the Bot's topic. A failure to send is logged, never fatal.
  readonly notify: (botId: BotId, text: string) => Effect.Effect<void, unknown>
}

export type PlanOutcome =
  // "trigger": the task does not need a plan. "state": it is no longer waiting for one (already planned, running, settled).
  | { readonly kind: "skipped"; readonly reason: "trigger" | "state" }
  | { readonly kind: "planned"; readonly plan: Plan; readonly warnings: ReadonlyArray<string> }
  | { readonly kind: "blocked"; readonly verdict: Verdict }

const NO_ANSWER = "the model gave no answer"
const SUMMARY_MAX = 300

export const makePlanner = (deps: PlannerDeps) => {
  const lifecycle = makeLifecycle({ beacon: deps.beacon, tasks: deps.tasks, bots: deps.bots })

  const say = (botId: BotId, text: string) =>
    deps.notify(botId, text).pipe(Effect.catch(() => Effect.logWarning("plan message not sent")))

  // One ask: the Plan checked against every rule, or the sentences that say what is wrong.
  const attempt = (
    task: TaskSpec,
    bots: ReadonlyArray<Bot>,
    previousProblems: ReadonlyArray<string> | undefined,
  ) =>
    Effect.gen(function* () {
      const prompt = buildPlanPrompt({
        task,
        bots,
        executors: usableExecutors(deps.executors),
        ...(previousProblems === undefined ? {} : { previousProblems }),
      })
      const reply = yield* deps
        .ask(task.botId, prompt)
        .pipe(Effect.mapError(() => [NO_ANSWER] as ReadonlyArray<string>))
      const draft = yield* readDraft(reply)
      // A code plan always ends with a review step (the Lead's own, not the model's).
      const review = task.kind === "code" ? { prompt: buildReviewPrompt(task) } : undefined
      return yield* checkDraft(draft, {
        taskId: task.id,
        budget: task.budget,
        bots,
        ...(review === undefined ? {} : { review }),
      })
    })

  // The model gets one retry, with the reasons of the first refusal. A second refusal is final.
  const build = (task: TaskSpec, bots: ReadonlyArray<Bot>) =>
    attempt(task, bots, undefined).pipe(Effect.catch((first) => attempt(task, bots, first)))

  const store = (task: TaskSpec, plan: Plan) =>
    deps.sql.withTransaction(
      Effect.gen(function* () {
        const encoded = yield* Schema.encodeEffect(Plan)(plan).pipe(Effect.orDie)
        yield* deps.sql`INSERT INTO plans (id, task_id, plan, state, created_at)
          VALUES (${plan.id}, ${task.id}, ${JSON.stringify(encoded)}, 'ready', ${nowIso()})`
        yield* lifecycle.taskEvent(task.id, "task.planned", {
          taskId: task.id,
          planId: plan.id,
          stepCount: plan.steps.length,
        })
        yield* lifecycle.transition(task, "ready", {}, "planned")
      }),
    )

  const block = (task: TaskSpec, problems: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const summary = clip(`no valid plan: ${problems.join("; ")}`, SUMMARY_MAX)
      const verdict = blockedVerdict(summary, "invalid plan")
      yield* lifecycle.transition(task, "failed", { verdict }, "invalid plan")
      // The Reflex decisions of this task get their (unknown) outcome now: nothing will run to confirm them.
      yield* lifecycle.recordOutcomes(task, "failed")
      yield* say(
        task.botId,
        `Não consegui montar um plano válido para a task "${clip(task.title, 80)}". Ela foi bloqueada.`,
      )
      return { kind: "blocked", verdict } satisfies PlanOutcome
    })

  // The work after the task entered planning: a Plan stored and the task ready, or the sentences that say why not.
  const produce = (task: TaskSpec) =>
    Effect.gen(function* () {
      const bots = (yield* deps.bots.list()).filter((bot) => bot.state !== "archived" && bot.name !== NEW_BOT)
      const built = yield* build(task, bots).pipe(Effect.result)
      if (built._tag === "Failure") {
        return { kind: "invalid", problems: built.failure } as const
      }
      const { plan: valid, warnings } = built.success
      yield* store(task, valid)
      if (warnings.length > 0) {
        yield* say(
          task.botId,
          "O orçamento dos passos passava o da task; reduzi cada passo na mesma proporção.",
        )
      }
      return { kind: "planned", plan: valid, warnings } as const
    })

  // Plans a task that meets the trigger and still waits for a plan (received, or planning after a resume):
  // planning -> ready with the Plan stored, or the task fails with a blocked verdict. Any failure after the task
  // entered planning (database, defect, model) ends the same way, so a task is never left in planning by an error.
  // An interruption is the exception: the task stays in planning and its recovery belongs to the one that resumes it.
  // Call it before any execution; validatePlan runs inside, so a stored plan is always valid.
  const plan = (task: TaskSpec, signals: PlanSignals = {}): Effect.Effect<PlanOutcome, SqlError | NotFound> =>
    Effect.gen(function* () {
      if (!shouldPlan(task, signals)) {
        return { kind: "skipped", reason: "trigger" } satisfies PlanOutcome
      }
      const { state } = yield* deps.tasks.get(task.id)
      if (state !== "received" && state !== "planning") {
        return { kind: "skipped", reason: "state" } satisfies PlanOutcome
      }
      yield* lifecycle.transition(task, "planning")
      const produced = yield* produce(task).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.succeed({
                kind: "invalid",
                problems: [`planning failed: ${describeFailure(Cause.squash(cause)).tag}`],
              } as const),
        ),
      )
      return produced.kind === "invalid" ? yield* block(task, produced.problems) : produced
    })

  return { plan }
}

export type Planner = ReturnType<typeof makePlanner>
