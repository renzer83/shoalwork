import {
  addUsage,
  type Bot,
  type ExecutorEvent,
  type ExecutorProtocolError,
  type ExecutorSpawnError,
  type StepId,
  type TaskSpec,
} from "@shoalwork/contracts"
import { Tank, type TankShape } from "@shoalwork/tank"
import { Effect, Ref, type Scope, Stream } from "effect"
import type { BudgetWatch } from "./budget.js"
import type { Lifecycle } from "./lifecycle.js"
import { type Progress, withOutcome } from "./verdict.js"

export interface ConsumeDeps {
  readonly taskEvent: Lifecycle["taskEvent"]
  readonly raiseError: Lifecycle["raiseError"]
  readonly tank: TankShape
}

// Consumes the executor stream until its first terminal event (or an approval request), recording every event.
export const makeConsume =
  ({ taskEvent, raiseError, tank }: ConsumeDeps) =>
  (
    spec: TaskSpec,
    bot: Bot,
    executorId: string,
    stream: Stream.Stream<ExecutorEvent, ExecutorSpawnError | ExecutorProtocolError, Tank | Scope.Scope>,
    stepId: StepId,
    progress: Ref.Ref<Progress>,
    model: string,
    // Told each usage event once it is recorded; it may cut the run (budget.ts).
    watch: Pick<BudgetWatch, "observe">,
  ) => {
    const ids = { taskId: spec.id, stepId, botId: bot.id }
    const handle = (event: ExecutorEvent): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        yield* taskEvent(spec.id, "executor.event", { ...ids, event })
        yield* Ref.update(progress, (p) => ({ ...p, events: p.events + 1 }))
        switch (event.kind) {
          case "text": {
            const text = event.text
            yield* Ref.update(progress, (p) => ({ ...p, lastText: text }))
            return true
          }
          case "started": {
            if (event.sessionId !== undefined) {
              const sessionId = event.sessionId
              yield* Ref.update(progress, (p) => ({ ...p, sessionId }))
            }
            return true
          }
          case "usage": {
            yield* Ref.update(progress, (p) => ({ ...p, usage: addUsage(p.usage, event.usage) }))
            yield* taskEvent(spec.id, "usage.recorded", {
              ...ids,
              executor: executorId,
              model,
              usage: event.usage,
            })
            yield* watch.observe(event.usage)
            return true
          }
          case "approval_needed": {
            yield* Ref.update(
              progress,
              withOutcome({ _tag: "Approval", action: event.action, risk: event.risk }),
            )
            return false
          }
          case "done": {
            yield* Ref.update(progress, (p) => ({
              ...p,
              sessionId: event.sessionId ?? p.sessionId,
              outcome: { _tag: "Done", result: event.result } as const,
            }))
            return false
          }
          case "error": {
            yield* Ref.update(
              progress,
              withOutcome({ _tag: "ExecutorError", code: event.code, message: event.message }),
            )
            return false
          }
          default:
            return true
        }
      })

    return stream.pipe(
      Stream.runForEachWhile(handle),
      Effect.scoped,
      Effect.provideService(Tank, tank),
      // Typed adapter failures are results of the run, not bugs.
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* Ref.update(
            progress,
            withOutcome({ _tag: "Channel", tag: error._tag, executor: error.executor }),
          )
          yield* raiseError(spec, "executor", error._tag, `executor ${error.executor} failed`)
        }),
      ),
    )
  }
