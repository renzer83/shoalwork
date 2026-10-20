import type { BotRegistryShape } from "@shoalwork/bots"
import { NotFound, TaskId } from "@shoalwork/contracts"
import { Effect, Option, Schema } from "effect"
import {
  type ControlRequest,
  controlFailedText,
  controlText,
  unknownBotText,
  unknownTaskText,
} from "./commands.js"
import { botTarget, type ControlShape, GLOBAL, taskTarget } from "./control.js"
import type { Lang } from "./narrator.js"

// /stop, /pause and /resume as the conversation answers them. A Bot is named by its name or its id. Never fails:
// an unknown Bot or task, or a database problem, becomes the reply.
export const makeControlReplies =
  (deps: { readonly bots: BotRegistryShape; readonly control: ControlShape }) =>
  (request: ControlRequest, by: string, language: Lang): Effect.Effect<string> => {
    const { bots, control } = deps
    return Effect.gen(function* () {
      if (request.scope === "task") {
        const taskId = Schema.decodeUnknownOption(TaskId)(request.id)
        if (Option.isNone(taskId)) {
          return unknownTaskText(request.id, language)
        }
        const report = yield* control.stop(taskTarget(taskId.value), by)
        return controlText(request, report.tasks.length, language)
      }
      const target =
        request.scope === "global"
          ? GLOBAL
          : botTarget(
              (yield* bots.list()).find((bot) => bot.name === request.name || bot.id === request.name)?.id ??
                (yield* Effect.fail(new NotFound({ entity: "Bot", id: request.name }))),
            )
      if (request.action === "stop") {
        const report = yield* control.stop(target, by)
        return controlText(request, report.tasks.length, language)
      }
      yield* request.action === "pause" ? control.pause(target, by) : control.resume(target, by)
      return controlText(request, 0, language)
    }).pipe(
      Effect.catch((failure) =>
        Effect.succeed(
          failure._tag === "NotFound"
            ? request.scope === "task"
              ? unknownTaskText(request.id, language)
              : unknownBotText(failure.id, language)
            : controlFailedText(language),
        ),
      ),
    )
  }
