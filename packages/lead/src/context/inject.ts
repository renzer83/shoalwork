import type { Bot, ExecutorId, ExecutorTask, TaskSpec } from "@shoalwork/contracts"
import { Tank, type TankContext, type TankShape } from "@shoalwork/tank"
import { Cause, Effect, type Scope } from "effect"
import { describeFailure } from "../verdict.js"
import { type Briefing, type BriefingMemory, buildBriefing, renderBriefing } from "./briefing.js"
import { removeInstructionFiles, writeInstructionFiles } from "./instructions-file.js"

export type { BriefingMemory } from "./briefing.js"

export interface InjectDeps {
  readonly tank: TankShape
  readonly memory: BriefingMemory | undefined
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
}

// Where the briefing goes when the worktree files cannot carry it: claude-code takes it as --append-system-prompt;
// codex has no system prompt flag, so it gets it at the head of the prompt.
const asInstructions = (task: ExecutorTask, executor: ExecutorId, briefing: Briefing): ExecutorTask => {
  const body = renderBriefing(briefing)
  return executor.startsWith("claude-code")
    ? { ...task, systemAppend: body }
    : { ...task, prompt: `${body}\n\n${task.prompt}` }
}

// The task as the executor should receive it. The briefing is written to the worktree (both CLIs read the files) unless
// the repo has instructions of its own; then, or when there is no worktree, it goes through asInstructions.
// The generated files are removed when the execution's scope closes, before the worktree is released.
// Never fails: a problem with the context is reported and the run goes on with what it has.
export const makeInjector =
  (deps: InjectDeps) =>
  (ctx: TankContext, input: InjectInput): Effect.Effect<ExecutorTask, never, Scope.Scope> => {
    const { spec, bot, task, executor } = input
    const report = (cause: Cause.Cause<unknown>) => {
      const { tag, message } = describeFailure(Cause.squash(cause))
      return deps.raiseError(spec, "lead.context", tag, message)
    }
    const stopOnInterrupt = (cause: Cause.Cause<unknown>, otherwise: Effect.Effect<void>) =>
      Cause.hasInterruptsOnly(cause) ? Effect.interrupt : otherwise

    return Effect.gen(function* () {
      const built = yield* buildBriefing(spec, bot, deps.memory).pipe(
        Effect.catchCause((cause) => stopOnInterrupt(cause, report(cause).pipe(Effect.as(undefined)))),
      )
      if (built === undefined) return task
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
