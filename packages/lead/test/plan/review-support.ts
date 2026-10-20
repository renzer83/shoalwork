import { Beacon } from "@shoalwork/beacon"
import {
  ExecutorId,
  type StepId,
  type Step as StepType,
  streamIds,
  type TaskId,
  type TaskSpec,
  type Verdict,
} from "@shoalwork/contracts"
import { Effect, Schema, Stream } from "effect"
import { emit } from "../../src/tasks.js"
import { checked, fakeIntegration, okVerdict, setupDispatch, step } from "./dispatch-support.js"

export const branchOf = (id: StepId) => `bot/dev/${id}`
export const CLAUDE = Schema.decodeUnknownSync(ExecutorId)("claude-code")
export const CODEX = Schema.decodeUnknownSync(ExecutorId)("codex")
export const FIX = "Fix review findings"

// A code plan: work steps, then the review step the Lead adds.
export const reviewed = (work: ReadonlyArray<StepType>) => {
  const review: StepType = {
    ...step(
      "Review",
      work.map((s) => s.id),
    ),
    kind: "review",
    parallelizable: false,
  }
  return [...work, review]
}

export const verdictOf = (summary: string, seconds = 0): Verdict => ({
  ...okVerdict(),
  summary,
  cost: { tokensIn: 0, tokensOut: 0, usd: 0, seconds },
})

export const started = (beacon: Beacon["Service"], spec: TaskSpec, executor: ExecutorId) =>
  emit(beacon, {
    streamId: streamIds.task(spec.id),
    type: "executor.started",
    payload: { taskId: spec.id, botId: spec.botId, executor, model: "m", cwd: "/work" },
    actor: "system:lead",
    correlationId: spec.id,
  })

export const typesOf = (beacon: Beacon["Service"], taskId: TaskId) =>
  Stream.runCollect(beacon.readStream(streamIds.task(taskId))).pipe(
    Effect.map((events) => Array.from(events).map((event) => ({ type: event.type, payload: event.payload }))),
  )

// Plays a plan whose work steps run on `worker` (and the fix on `fixer`); `answer` is what each review round says.
export const play = (
  steps: ReadonlyArray<StepType>,
  options: {
    readonly answer: (round: number, spec: TaskSpec) => Verdict
    readonly worker?: ExecutorId | undefined
    readonly fixer?: ExecutorId
    readonly verify?: Parameters<typeof setupDispatch>[1]["verify"]
  },
) =>
  Effect.gen(function* () {
    const beacon = yield* Beacon
    const integration = yield* fakeIntegration()
    let round = 0
    const made = yield* setupDispatch(reviewed(steps), {
      integration,
      ...(options.verify === undefined ? {} : { verify: options.verify }),
      run: ({ step: s, spec }) =>
        Effect.gen(function* () {
          if (spec.review !== undefined) return options.answer(++round, spec)
          const executor = spec.title === FIX ? (options.fixer ?? CODEX) : options.worker
          if (executor !== undefined) yield* started(beacon, spec, executor)
          return okVerdict(spec.title === FIX ? `bot/dev/fix-${s.id}` : branchOf(s.id))
        }),
    })
    const result = yield* made.dispatcher.run(made.plan, made.assignments)
    return { ...made, result, integration, beacon }
  })

export const reviewsOf = (specs: ReadonlyArray<TaskSpec>) => specs.filter((spec) => spec.review !== undefined)

// The review step answers with `cut` in its verdict; `withEvent` also writes the full text as the executor's done event.
export const playCut = (beacon: Beacon["Service"], full: string, cut: string, withEvent: boolean) =>
  Effect.gen(function* () {
    const integration = yield* fakeIntegration()
    let round = 0
    const made = yield* setupDispatch(reviewed([checked("a")]), {
      integration,
      run: ({ step: s, spec }) =>
        Effect.gen(function* () {
          if (spec.review === undefined) {
            yield* started(beacon, spec, spec.title === FIX ? CODEX : CLAUDE)
            return okVerdict(spec.title === FIX ? `bot/dev/fix-${s.id}` : branchOf(s.id))
          }
          if (++round > 1) return verdictOf("NONE")
          if (withEvent) {
            yield* emit(beacon, {
              streamId: streamIds.task(spec.id),
              type: "executor.event",
              payload: {
                taskId: spec.id,
                botId: spec.botId,
                event: { kind: "done", result: full, artifacts: [] },
              },
              actor: "system:lead",
              correlationId: spec.id,
            })
          }
          return verdictOf(cut)
        }),
    })
    const result = yield* made.dispatcher.run(made.plan, made.assignments)
    return { result, specs: made.specs }
  })
