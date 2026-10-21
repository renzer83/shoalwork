import type { Bot, ExecutorId, ExecutorTask, TaskSpec } from "@shoalwork/contracts"
import { Tank, type TankContext, type TankShape } from "@shoalwork/tank"
import { Cause, Effect, type Scope } from "effect"
import type { Carry } from "../retry.js"
import { describeFailure } from "../verdict.js"
import {
  type Briefing,
  type BriefingCode,
  type BriefingMemory,
  type BriefingRankedCode,
  buildBriefing,
} from "./briefing.js"
import { type ContextConfig, DEFAULT_CONTEXT_CONFIG } from "./config.js"
import { removeInstructionFiles, writeInstructionFiles } from "./instructions-file.js"
import { fallbackDecision, makeContextPlanner, type PlanningDecision } from "./planner.js"

export type { BriefingCode, BriefingMemory, BriefingRankedCode } from "./briefing.js"

// Payload of the context.assembled event.
export interface ContextAssembled {
  readonly taskId: TaskSpec["id"]
  readonly level: Briefing["level"]
  readonly used: number
  readonly budget: number
  readonly dropped: Briefing["dropped"]
  // Code candidates the ranker considered: normalized signals (bm25, cosine, recency, imports, success, proximity).
  readonly ranked?: ReadonlyArray<RankedEntry> | undefined
}

export interface RankedEntry {
  readonly id: string
  readonly used: boolean
  readonly signals: readonly [number, number, number, number, number, number]
}

const SIGNAL_DECIMALS = 1000
const round3 = (value: number): number => Math.round(value * SIGNAL_DECIMALS) / SIGNAL_DECIMALS

const rankedEntries = (briefing: Briefing): ReadonlyArray<RankedEntry> | undefined =>
  briefing.ranked?.map((entry) => ({
    id: entry.id,
    used: entry.used,
    signals: [
      round3(entry.signals.bm25),
      round3(entry.signals.cosine),
      round3(entry.signals.recency),
      round3(entry.signals.imports),
      round3(entry.signals.success),
      round3(entry.signals.proximity),
    ],
  }))

export interface InjectDeps {
  readonly tank: TankShape
  readonly memory: BriefingMemory | undefined
  // The repo index search; without it the briefing carries no code.
  readonly code?: BriefingCode | undefined
  // The same search ranked with the six signals; it serves the code block when present, `code` is the fallback.
  readonly rankedCode?: BriefingRankedCode | undefined
  // config/context.yaml (or the defaults): budgets per tier, block caps and the size of each level.
  readonly config?: ContextConfig | undefined
  // Records the context.assembled event. A failure to record never fails the run.
  readonly recordAssembled?:
    | ((spec: Pick<TaskSpec, "id">, payload: ContextAssembled) => Effect.Effect<void, unknown>)
    | undefined
  // The Lead's error reporting (lifecycle.ts). A problem with the context never fails the run.
  readonly raiseError: (
    spec: Pick<TaskSpec, "id" | "botId">,
    where: string,
    tag: string,
    message: string,
  ) => Effect.Effect<void>
}

export interface InjectInput {
  readonly spec: TaskSpec
  readonly bot: Bot
  readonly task: ExecutorTask
  readonly executor: ExecutorId
  // The Reflex decision of the task, when the caller has it; otherwise the tier stands in for the complexity.
  readonly decision?: PlanningDecision | undefined
  // The run's carry (retry.ts): its working lines (resume.ts) go into the briefing.
  readonly carry?: Carry | undefined
  // Files the task is about besides the ones its prompt names (retry: the files the previous attempt edited).
  readonly activeFiles?: ReadonlyArray<string> | undefined
}

// Where the briefing goes when the worktree files cannot carry it: claude-code takes it as --append-system-prompt;
// codex has no system prompt flag, so it gets it at the head of the prompt.
const asInstructions = (task: ExecutorTask, executor: ExecutorId, briefing: Briefing): ExecutorTask =>
  executor.startsWith("claude-code")
    ? { ...task, systemAppend: briefing.text }
    : { ...task, prompt: `${briefing.text}\n\n${task.prompt}` }

// The task as the executor should receive it. The briefing is written to the worktree (both CLIs read the files) unless
// the repo has instructions of its own; then, or when there is no worktree, it goes through asInstructions.
// The generated files are removed when the execution's scope closes, before the worktree is released.
// Never fails: a problem with the context is reported and the run goes on with what it has.
export const makeInjector = (deps: InjectDeps) => {
  const config = deps.config ?? DEFAULT_CONTEXT_CONFIG
  const planner = makeContextPlanner(config)
  return (ctx: TankContext, input: InjectInput): Effect.Effect<ExecutorTask, never, Scope.Scope> => {
    const { spec, bot, task, executor } = input
    const report = (cause: Cause.Cause<unknown>, where = "lead.context") => {
      const { tag, message } = describeFailure(Cause.squash(cause))
      return deps.raiseError(spec, where, tag, message)
    }
    const stopOnInterrupt = (cause: Cause.Cause<unknown>, otherwise: Effect.Effect<void>) =>
      Cause.hasInterruptsOnly(cause) ? Effect.interrupt : otherwise

    const announce = (briefing: Briefing) =>
      deps.recordAssembled === undefined
        ? Effect.void
        : deps
            .recordAssembled(spec, {
              taskId: spec.id,
              level: briefing.level,
              used: briefing.used,
              budget: briefing.budget,
              dropped: briefing.dropped,
              ...(briefing.ranked === undefined ? {} : { ranked: rankedEntries(briefing) }),
            })
            .pipe(Effect.catchCause((cause) => stopOnInterrupt(cause, report(cause))))

    return Effect.gen(function* () {
      const plan = planner.plan(spec, input.decision ?? fallbackDecision(spec.tier))
      const built = yield* buildBriefing(
        {
          memory: deps.memory,
          code: deps.code,
          rankedCode: deps.rankedCode,
          tank: deps.tank,
          onSourceError: (source, cause) => report(cause, `lead.context.${source}`),
        },
        { spec, bot, ctx, plan, config, working: input.carry?.working, activeFiles: input.activeFiles },
      ).pipe(Effect.catchCause((cause) => stopOnInterrupt(cause, report(cause).pipe(Effect.as(undefined)))))
      if (built === undefined) return task
      yield* announce(built)
      if (ctx.worktree === undefined) return asInstructions(task, executor, built)
      const written = yield* writeInstructionFiles(ctx, built).pipe(
        Effect.provideService(Tank, deps.tank),
        Effect.catchCause((cause) => stopOnInterrupt(cause, report(cause).pipe(Effect.as(undefined)))),
      )
      if (written === undefined) return asInstructions(task, executor, built)
      yield* Effect.addFinalizer(() =>
        removeInstructionFiles(ctx).pipe(
          Effect.provideService(Tank, deps.tank),
          Effect.catchCause((cause) => stopOnInterrupt(cause, report(cause))),
        ),
      )
      return written.conflict ? asInstructions(task, executor, built) : task
    })
  }
}
