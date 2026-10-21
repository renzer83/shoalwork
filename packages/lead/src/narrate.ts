import type { BeaconShape } from "@shoalwork/beacon"
import {
  type BotId,
  type Event,
  EventPayloads,
  type TaskId,
  TaskId as TaskIdSchema,
} from "@shoalwork/contracts"
import type { TelegramOutShape } from "@shoalwork/currents"
import { Cause, Clock, Effect, Option, Schema, type Scope, Semaphore, Stream } from "effect"
import { askedInChat, infoFrom, type TaskInfo } from "./narrate-info.js"
import {
  botBudgetPhrase,
  budgetPhrase,
  cancelledPhrase,
  commandPhrase,
  donePhrase,
  editPhrase,
  failedPhrase,
  type Lang,
  mayNarrate,
  needsYouPhrase,
  retryingPhrase,
  SUMMARY_LONG,
  startedPhrase,
} from "./narrator.js"
import { type ChannelOut, channelOfOrigin, makeReplyPort, telegramChannelOut } from "./reply-port.js"
import type { TaskStoreShape } from "./tasks.js"
import { clip } from "./verdict.js"

// Events that become phrases in the Bot's topic.
const NARRATED = ["executor.started", "executor.event", "task.state_changed", "budget.exceeded"] as const

const Started = EventPayloads["executor.started"]
const Progress = EventPayloads["executor.event"]
const StateChanged = EventPayloads["task.state_changed"]
const Budget = EventPayloads["budget.exceeded"]

const decodeStarted = Schema.decodeUnknownOption(Started)
const decodeProgress = Schema.decodeUnknownOption(Progress)
const decodeStateChanged = Schema.decodeUnknownOption(StateChanged)
const decodeBudget = Schema.decodeUnknownOption(Budget)

export interface NarrateDeps {
  readonly beacon: BeaconShape
  readonly tasks: TaskStoreShape
  // Absent: Telegram is off, and what would go there is dropped.
  readonly telegram?: TelegramOutShape
  // Where the tasks asked in the app are narrated. Absent: those tasks are not narrated.
  readonly app?: ChannelOut
  // Language the task was asked in (the conversation remembers it); Portuguese when unknown.
  readonly languageOf: (taskId: TaskId) => Lang
  readonly forget: (taskId: TaskId) => void
  // A verdict summary too long for one line, cut to two sentences by the chat tier. Failure keeps a clipped copy.
  readonly summarize: (summary: string, language: Lang) => Effect.Effect<string>
}

interface TaskNarration {
  runs: number
  lastSentMs: number | undefined
  info: TaskInfo | undefined
}

// Summaries being shortened at the same time; the others wait without holding up the event loop.
const SUMMARIZE_CONCURRENCY = 2

// Turns the task's events into short messages in the owning Bot's topic: one progress line per window,
// never held back for the start of a retry, the end of the task or an exhausted budget. Tasks that did not come
// from a chat (Telegram, the app) get only their start and their end.
export const startNarrator = (deps: NarrateDeps): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const reply = makeReplyPort({
      ...(deps.telegram === undefined ? {} : { telegram: telegramChannelOut(deps.telegram) }),
      ...(deps.app === undefined ? {} : { app: deps.app }),
    })
    const summaries = Semaphore.makeUnsafe(SUMMARIZE_CONCURRENCY)
    const states = new Map<TaskId, TaskNarration>()
    const stateOf = (taskId: TaskId): TaskNarration => {
      const known = states.get(taskId)
      if (known !== undefined) {
        return known
      }
      const created: TaskNarration = {
        runs: 0,
        lastSentMs: undefined,
        info: undefined,
      }
      states.set(taskId, created)
      return created
    }

    // Read once per task (a failed read is tried again, twice). Undefined when the task cannot be read: the narrator
    // then says nothing, because it would not know which chat the task belongs to.
    const infoOf = (taskId: TaskId) =>
      Effect.gen(function* () {
        const state = stateOf(taskId)
        if (state.info === undefined) {
          const found = yield* deps.tasks.get(taskId).pipe(Effect.retry({ times: 2 }), Effect.option)
          if (Option.isNone(found)) {
            return undefined
          }
          state.info = infoFrom(found.value.spec)
        }
        return state.info
      })

    const say = (taskId: TaskId, botId: BotId, text: string, urgent: boolean) =>
      Effect.gen(function* () {
        const info = yield* infoOf(taskId)
        if (info === undefined) {
          yield* Effect.logWarning("narration skipped: the task cannot be read", taskId)
          return
        }
        const channel = channelOfOrigin(info.origin)
        if (
          (channel === "telegram" && deps.telegram === undefined) ||
          (channel === "app" && deps.app === undefined)
        ) {
          return
        }
        // A plan's step is narrated once, in its Pod's topic: the Bot's topic gets nothing for it.
        if (info.podStep) {
          return
        }
        const state = stateOf(taskId)
        const now = yield* Clock.currentTimeMillis
        if (!mayNarrate(now, state.lastSentMs, urgent)) {
          return
        }
        state.lastSentMs = now
        // The reply carries the task's correlation id, so the message and its narration are one thread in the log.
        yield* reply
          .send(channel, botId, text, {
            ...(info.correlationId === undefined ? {} : { correlationId: info.correlationId }),
          })
          .pipe(Effect.catch((error) => Effect.logWarning("narration not sent", error.op)))
      })

    const narratesProgress = (taskId: TaskId) =>
      Effect.map(infoOf(taskId), (info) => info !== undefined && askedInChat(info.origin))

    const onStarted = (payload: typeof Started.Type) =>
      Effect.gen(function* () {
        const state = stateOf(payload.taskId)
        state.runs += 1
        const language = deps.languageOf(payload.taskId)
        const retry = state.runs > 1
        if (retry && !(yield* narratesProgress(payload.taskId))) {
          return
        }
        yield* say(
          payload.taskId,
          payload.botId,
          retry ? retryingPhrase(state.runs, language) : startedPhrase(language),
          retry,
        )
      })

    const onProgress = (payload: typeof Progress.Type) =>
      Effect.gen(function* () {
        const language = deps.languageOf(payload.taskId)
        const { event } = payload
        if (!(yield* narratesProgress(payload.taskId))) {
          return
        }
        if (event.kind === "command") {
          yield* say(payload.taskId, payload.botId, commandPhrase(event.cmd, language), false)
        } else if (event.kind === "file_edit") {
          yield* say(payload.taskId, payload.botId, editPhrase(event.path, language), false)
        }
      })

    const onStateChanged = (payload: typeof StateChanged.Type) =>
      Effect.gen(function* () {
        if (payload.to !== "done" && payload.to !== "failed" && payload.to !== "cancelled") {
          return
        }
        const language = deps.languageOf(payload.taskId)
        const found = yield* deps.tasks.get(payload.taskId).pipe(Effect.option)
        if (Option.isNone(found)) {
          return
        }
        const record = found.value
        // Already read: the channel is known even if an earlier read failed.
        stateOf(payload.taskId).info ??= infoFrom(record.spec)
        const summary = record.verdict?.summary ?? ""
        const botId = record.spec.botId
        if (payload.to === "cancelled") {
          yield* say(payload.taskId, botId, cancelledPhrase(language), true)
        } else if (payload.to === "done") {
          if (summary.length > SUMMARY_LONG) {
            // Shortened off the event loop: a slow model must not delay the other tasks' messages.
            const announce = summaries.withPermits(1)(
              deps
                .summarize(summary, language)
                .pipe(
                  Effect.flatMap((short) => say(payload.taskId, botId, donePhrase(short, language), true)),
                ),
            )
            yield* Effect.forkIn(
              announce.pipe(Effect.ensuring(Effect.sync(() => states.delete(payload.taskId)))),
              scope,
            )
          } else {
            yield* say(payload.taskId, botId, donePhrase(summary, language), true)
          }
        } else if (payload.reason === "max retries") {
          yield* say(payload.taskId, botId, needsYouPhrase(summary, language), true)
        } else if (record.verdict?.kind !== "budget_exceeded") {
          // A spent budget already has its own message (budget.exceeded).
          yield* say(
            payload.taskId,
            botId,
            failedPhrase(summary === "" ? payload.to : summary, language),
            true,
          )
        }
        states.delete(payload.taskId)
        deps.forget(payload.taskId)
      })

    // A task-scope event names the task in refId; a Bot-scope one names the Bot, and the task is the event's stream.
    const onBudget = (payload: typeof Budget.Type, streamId: string) =>
      Effect.gen(function* () {
        if (payload.scope === "pod") {
          return
        }
        const taskId = Schema.decodeUnknownOption(TaskIdSchema)(
          payload.scope === "bot" ? streamId.replace(/^task:/, "") : payload.refId,
        )
        const found = Option.isNone(taskId)
          ? Option.none()
          : yield* deps.tasks.get(taskId.value).pipe(Effect.option)
        if (Option.isSome(found)) {
          const { spec, attempts } = found.value
          stateOf(spec.id).info ??= infoFrom(spec)
          // A chat task refused for its Bot's budget was answered in its topic (conversation-replies.ts).
          if (payload.scope === "bot" && attempts === 0 && askedInChat(spec.origin)) {
            return
          }
          const language = deps.languageOf(spec.id)
          const phrase = payload.scope === "bot" ? botBudgetPhrase(language) : budgetPhrase(language)
          yield* say(spec.id, spec.botId, phrase, true)
        }
      })

    const handle = (event: Event): Effect.Effect<void> => {
      switch (event.type) {
        case "executor.started":
          return Option.match(decodeStarted(event.payload), { onNone: () => Effect.void, onSome: onStarted })
        case "executor.event":
          return Option.match(decodeProgress(event.payload), {
            onNone: () => Effect.void,
            onSome: onProgress,
          })
        case "task.state_changed":
          return Option.match(decodeStateChanged(event.payload), {
            onNone: () => Effect.void,
            onSome: onStateChanged,
          })
        case "budget.exceeded":
          return Option.match(decodeBudget(event.payload), {
            onNone: () => Effect.void,
            onSome: (payload) => onBudget(payload, event.streamId),
          })
        default:
          return Effect.void
      }
    }

    const stream = yield* deps.beacon.subscribe(NARRATED)
    yield* stream.pipe(
      Stream.runForEach((event) =>
        handle(event).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logError("narration failed", clip(Cause.pretty(cause), 200)),
          ),
        ),
      ),
      Effect.forkScoped,
    )
  })
