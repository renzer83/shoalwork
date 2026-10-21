import { Beacon } from "@shoalwork/beacon"
import { BotRegistry } from "@shoalwork/bots"
import type { TaskId } from "@shoalwork/contracts"
import { GhClient, TelegramOut } from "@shoalwork/currents"
import { ChatSessions, ExecutorRegistry, type TierConfig } from "@shoalwork/executors"
import { Policy } from "@shoalwork/policy"
import { Reef } from "@shoalwork/reef"
import { criterionRule } from "@shoalwork/reflex"
import { Tank } from "@shoalwork/tank"
import { Context, Effect, Layer, Option, type Scope, Stream } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { botOverBudget } from "./budget.js"
import { makeChat } from "./chat.js"
import { Control } from "./control.js"
import { Lead } from "./lead.js"
import { makeLifecycle } from "./lifecycle.js"
import { makeDispatcher, PLAN_STOPPED_REASON } from "./plan/dispatcher.js"
import { makeIntegration } from "./plan/integration.js"
import { makePlanner } from "./plan/planner.js"
import { makeStepVerify, policyAllow, type StepVerifyDeps } from "./plan/step-verify.js"
import { makePlanFlow } from "./plan-flow.js"
import { signalsOf } from "./plan-signals.js"
import { forgetNotes, PodNotes } from "./pod-notes.js"
import { makePods, type Pods, type PodTopicPort } from "./pods.js"
import { appChannelOut, makeReplyPort, notifyForTask, telegramChannelOut } from "./reply-port.js"
import type { RunResult } from "./runner.js"
import { TaskStore } from "./tasks.js"
import { isSettled } from "./verdict.js"

export interface PlanningOptions {
  // config PLAN_CONCURRENCY.
  readonly planConcurrency: number
  readonly botBudgetWindowMs: number
  // "telegram": the Pod's topic is a forum topic. "none": Telegram is off, the Pod has no topic and posts go nowhere.
  readonly topics: "telegram" | "none"
  // The Reflex "result meets criterion?" question for the verifier. Default: the v0 rule (packages/reflex).
  readonly judge?: StepVerifyDeps["judge"]
}

export interface PlanningShape {
  // The run of a claimed job: planning in front of the ordinary run (give it to Lead.startWorker as `runTask`).
  readonly run: (id: TaskId) => Effect.Effect<RunResult>
  // Messages typed in an open Pod's topic (bind to TelegramConfig.pods).
  readonly onHumanMessage: Pods["onHumanMessage"]
  // Narrates the plan's steps in the Pods' topics until the scope ends.
  readonly start: Effect.Effect<void, never, Scope.Scope>
}

export class Planning extends Context.Service<Planning, PlanningShape>()("@shoalwork/Planning") {}

// Telegram is off: the Pod has no topic (thread 0 matches no real thread) and its posts go nowhere.
export const NO_TOPICS: PodTopicPort = { open: () => Effect.succeed(0), post: () => Effect.void }

export const PlanningLive = (
  tiers: TierConfig,
  options: PlanningOptions,
): Layer.Layer<
  Planning,
  never,
  | Lead
  | Control
  | SqlClient
  | Beacon
  | BotRegistry
  | TaskStore
  | Tank
  | GhClient
  | ExecutorRegistry
  | ChatSessions
  | TelegramOut
  | PodNotes
> =>
  Layer.effect(
    Planning,
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const beacon = yield* Beacon
      const bots = yield* BotRegistry
      const tasks = yield* TaskStore
      const tank = yield* Tank
      const gh = yield* GhClient
      const executors = yield* ExecutorRegistry
      const sessions = yield* ChatSessions
      const telegram = yield* TelegramOut
      const reply = makeReplyPort({ telegram: telegramChannelOut(telegram), app: appChannelOut(beacon) })
      const lead = yield* Lead
      const control = yield* Control
      const notes = yield* PodNotes
      const reef = Option.getOrUndefined(yield* Effect.serviceOption(Reef))
      // The Policy is optional in the core for now: without one no check command is allowed (needs_human).
      const policy = Option.getOrUndefined(yield* Effect.serviceOption(Policy))
      const lifecycle = makeLifecycle({ beacon, tasks, bots })
      const chat = makeChat({ tank, bots, executors, sessions, tiers })

      const topic: PodTopicPort =
        options.topics === "none"
          ? NO_TOPICS
          : {
              open: (name) => telegram.openPodTopic(name),
              post: (threadId, text) => telegram.postToPodTopic(threadId, text),
            }
      const pods = makePods({
        sql,
        beacon,
        tasks,
        bots,
        topic,
        // Light tier: the instructions of an auxiliary Bot are short, structured text.
        ask: (botId, prompt) => chat.once(botId, "decision", prompt),
        // A message for a running step waits for the task's next round (retry/carry), see pod-notes.ts.
        resume: (taskId, message) => notes.push(taskId, message.note ?? ""),
        // Episodic summary in the pod scope of the Reef; without a Reef nothing is kept.
        remember: (podId, summary) =>
          reef === undefined
            ? Effect.void
            : reef
                .remember({
                  scope: "pod",
                  ownerId: podId,
                  kind: "episodic",
                  content: summary,
                  source: `pod:${podId}`,
                })
                .pipe(Effect.asVoid),
      })
      const planner = makePlanner({
        sql,
        beacon,
        tasks,
        bots,
        ask: (botId, prompt) => chat.heavy(botId, prompt),
        executors: executors.list(),
        // A plan message follows the task's origin: an app task is answered in the app, never on Telegram.
        notify: notifyForTask(reply),
      })
      const dispatcher = makeDispatcher({
        sql,
        beacon,
        tasks,
        runTask: (id) => lead.runTask(id),
        // A step an interruption left unfinished is cancelled (it did not fail); anything else closes as usual.
        abandon: (id, reason) =>
          reason === PLAN_STOPPED_REASON
            ? tasks.get(id).pipe(
                Effect.flatMap((record) =>
                  isSettled(record.state) ? Effect.void : lifecycle.cancelUnstarted(record.spec, reason),
                ),
                Effect.catchCause(() => lead.abandon(id, reason)),
              )
            : lead.abandon(id, reason),
        overBudget: (botId) =>
          bots.get(botId).pipe(
            Effect.flatMap((bot) => botOverBudget(beacon, bot, options.botBudgetWindowMs)),
            Effect.catchTag("NotFound", () => Effect.succeed(false)),
          ),
        integration: makeIntegration({ tank, gh, bots }),
        verify: makeStepVerify({
          tank,
          bots,
          allow: policyAllow(policy),
          judge: options.judge ?? ((facts) => Effect.succeed(criterionRule(facts.tests))),
        }),
        concurrency: options.planConcurrency,
      })
      const flow = makePlanFlow({
        sql,
        beacon,
        tasks,
        bots,
        control,
        planner,
        pods,
        dispatcher,
        signalsOf: (spec) => signalsOf(sql, spec),
        runTask: (id) => lead.runTask(id),
      })
      const start: PlanningShape["start"] = Effect.gen(function* () {
        const events = yield* beacon.subscribe(["task.state_changed", "agent.msg"])
        yield* events.pipe(
          Stream.runForEach((event) =>
            Effect.andThen(
              forgetNotes(notes, event),
              pods
                .narrate(event)
                .pipe(Effect.catch((error) => Effect.logWarning("pod narration failed", error._tag))),
            ),
          ),
          Effect.forkScoped,
        )
      })
      return { run: flow.run, onHumanMessage: pods.onHumanMessage, start }
    }),
  )
