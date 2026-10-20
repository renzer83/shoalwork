import {
  client as acpClient,
  type ClientContext,
  methods,
  PROTOCOL_VERSION,
  RequestError,
} from "@agentclientprotocol/sdk"
import {
  type ExecutorErrorCode,
  type ExecutorEvent,
  type ExecutorId,
  type ExecutorProtocolError,
  ExecutorSpawnError,
  type ExecutorTask,
  exceeds,
  SessionId,
} from "@shoalwork/contracts"
import { Tank } from "@shoalwork/tank"
import { type Cause, Clock, Data, Duration, Effect, Option, Queue, Schema, type Scope, Stream } from "effect"
import type { Executor, ExecutorContext } from "../executor.js"
import { makeQuotaCounter, type QuotaCounter } from "../quota.js"
import { captureStderr, endedWithoutResult } from "../stderr.js"
import { makeAcpMapper } from "./events.js"
import { readTextFile, writeTextFile } from "./fs.js"
import { type AcpPolicy, handlePermission } from "./permissions.js"
import { makeRunRequest, openTransport } from "./transport.js"

export type { AcpPolicy } from "./permissions.js"

export type AcpOptions = {
  // ExecutorId has no ":" (T-017), so the "acp:<bin>" of the architecture is written e.g. "acp-gemini".
  readonly id: ExecutorId
  readonly bin: string
  // Flags that put the CLI in ACP mode (`--acp`, `acp`), after the binary.
  readonly args: ReadonlyArray<string>
  // Answers request_permission. `Policy.evaluate` of @shoalwork/policy fits.
  readonly policy: AcpPolicy
  readonly quotaWindowSeconds: number
  readonly quotaSoftLimitTokens: number
  // Reported by mapTier; ACP v1 has no model switch, the agent uses its own configured model.
  readonly model?: string
}

class AcpFailure extends Data.TaggedError("AcpFailure")<{
  readonly code: ExecutorErrorCode
  readonly message: string
}> {}

const MESSAGE_MAX_CHARS = 500
// JSON-RPC code ACP uses for "authenticate first".
const AUTH_REQUIRED = -32000

const isEnd = (event: ExecutorEvent): boolean =>
  event.kind === "done" || event.kind === "error" || event.kind === "approval_needed"

// Defensive, written against @agentclientprotocol/sdk 1.9.0: a response resolves its promise as soon as it is read,
// while a notification reaches its handler after a few promise hops. An update sent just before a response could then
// be handled after it (a replayed line leaking into the run, or the last chunk after the stop). One macrotask lets
// those hops finish first. If a later SDK orders them, this is merely a no-op.
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

const one = (event: ExecutorEvent): Stream.Stream<ExecutorEvent> => Stream.make(event)

// How long a dead agent gets to report its exit code after SIGKILL before the run reports it as unknown.
const EXIT_WAIT = Duration.seconds(5)

const failureEvent = (failure: unknown): ExecutorEvent | undefined => {
  if (failure instanceof AcpFailure) return { kind: "error", code: failure.code, message: failure.message }
  if (failure instanceof RequestError) {
    return {
      kind: "error",
      code: failure.code === AUTH_REQUIRED ? "auth" : "protocol",
      message: `agent error ${failure.code}: ${failure.message.slice(0, MESSAGE_MAX_CHARS)}`,
    }
  }
  return undefined
}

const runAcp = (
  opts: AcpOptions,
  task: ExecutorTask,
  ctx: ExecutorContext,
  quota: QuotaCounter,
): Stream.Stream<ExecutorEvent, ExecutorSpawnError | ExecutorProtocolError, Tank | Scope.Scope> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const tank = yield* Tank
      const spawnFailure = (cause: unknown) => new ExecutorSpawnError({ executor: opts.id, cause })
      const proc = yield* tank.spawnStream(ctx, [opts.bin, ...opts.args]).pipe(Effect.mapError(spawnFailure))
      const stderrTail = yield* captureStderr(proc.stderr.pipe(Stream.mapError(spawnFailure)))
      const transport = yield* openTransport(proc)
      const queue = yield* Queue.unbounded<ExecutorEvent, Cause.Done>()

      const run = Effect.runPromiseWith(yield* Effect.context<never>())
      const runRequest = makeRunRequest(run)
      const mapper = makeAcpMapper({ resumed: task.resumeSessionId !== undefined })
      const startedAt = yield* Clock.currentTimeMillis
      const spent = { tokens: 0, usd: 0 }
      const state = {
        finished: false,
        expired: false,
        live: false,
        sessionId: undefined as string | undefined,
        failure: undefined as unknown,
      }
      const emit = (events: ReadonlyArray<ExecutorEvent>): void => {
        for (const event of events) {
          if (state.finished) return
          Queue.offerUnsafe(queue, event)
          if (isEnd(event)) {
            state.finished = true
            Queue.endUnsafe(queue)
            return
          }
          if (event.kind === "usage") {
            spent.tokens += event.usage.tokensIn + event.usage.tokensOut
            spent.usd += event.usage.usd
            const over = exceeds({ ...spent, seconds: 0 }, task.budget)
            // What the agent reports is checked as it arrives, like the other executors: usage first, then the cut.
            if (over.exceeded) {
              emit([{ kind: "error", code: "budget", message: `${over.by.join(" and ")} budget exceeded` }])
              return
            }
          }
        }
      }

      const fsDeps = {
        tank,
        ctx,
        botId: task.botId,
        policy: opts.policy,
        readonly: task.permissionMode === "readonly",
      }
      const permissionDeps = { botId: task.botId, cwd: ctx.cwd, roots: [ctx.home], policy: opts.policy }
      const app = acpClient({ name: "shoalwork" })
        .onRequest(methods.client.session.requestPermission, async (call) => {
          const outcome = await runRequest(handlePermission(permissionDeps, call.params))
          // One pause per run: a second ask, or any ask after the end, is cancelled without a second event.
          if (state.finished) return { outcome: { outcome: "cancelled" as const } }
          if (outcome.ask !== undefined) {
            emit([{ kind: "approval_needed", action: outcome.ask.action, risk: outcome.ask.risk }])
          }
          return outcome.response
        })
        .onRequest(methods.client.fs.readTextFile, (call) => runRequest(readTextFile(fsDeps, call.params)))
        .onRequest(methods.client.fs.writeTextFile, (call) => runRequest(writeTextFile(fsDeps, call.params)))
        .onNotification(methods.client.session.update, (call) => {
          // Updates replayed while a session loads are history, not work of this run.
          if (state.live && call.params.sessionId === state.sessionId) emit(mapper.push(call.params.update))
        })

      const drive = async (agent: ClientContext): Promise<void> => {
        const init = await agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
        })
        const resuming = task.resumeSessionId
        if (resuming !== undefined) {
          if (init.agentCapabilities?.loadSession !== true) {
            throw new AcpFailure({
              code: "protocol",
              message: "the agent cannot load sessions, so it cannot resume",
            })
          }
          state.sessionId = resuming
          await agent.request(methods.agent.session.load, {
            sessionId: resuming,
            cwd: ctx.cwd,
            mcpServers: [],
          })
          await flush()
        } else {
          const created = await agent.request(methods.agent.session.new, { cwd: ctx.cwd, mcpServers: [] })
          await flush()
          state.sessionId = created.sessionId
        }
        state.live = true
        const sessionId = Schema.decodeUnknownSync(SessionId)(state.sessionId)
        emit([{ kind: "started", sessionId, ...(opts.model === undefined ? {} : { model: opts.model }) }])
        const text =
          resuming !== undefined || task.systemAppend === undefined
            ? task.prompt
            : `${task.systemAppend}\n\n${task.prompt}`
        const response = await agent.request(methods.agent.session.prompt, {
          sessionId: sessionId,
          prompt: [{ type: "text", text }],
        })
        await flush()
        const now = await run(Clock.currentTimeMillis)
        emit(mapper.finish(response, sessionId, Math.round((now - startedAt) / 1000)))
      }

      yield* Effect.tryPromise({
        try: () => app.connectWith(transport, drive),
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            state.failure = error
            if (!state.finished) Queue.endUnsafe(queue)
          }),
        ),
        Effect.forkScoped,
      )

      // Wall-clock budget: when it fires, the upstream is cut and the process is killed; `tail` reports it.
      const deadline = Effect.sleep(Duration.seconds(task.budget.seconds)).pipe(
        Effect.andThen(
          Effect.sync(() => {
            state.expired = true
          }),
        ),
        Effect.andThen(proc.kill()),
      )
      // Runs only when no terminal event was emitted: budget cut, an error of the agent, or a process that ended.
      const tail: Stream.Stream<ExecutorEvent> = Stream.unwrap(
        Effect.suspend((): Effect.Effect<Stream.Stream<ExecutorEvent>> => {
          if (state.finished) return Effect.succeed(Stream.empty)
          if (state.expired) {
            return Effect.succeed(
              one({
                kind: "error",
                code: "budget",
                message: `wall-clock budget of ${task.budget.seconds}s exceeded`,
              }),
            )
          }
          const known = failureEvent(state.failure)
          if (known !== undefined) return Effect.succeed(one(known))
          return proc.kill("SIGKILL").pipe(
            Effect.andThen(Effect.all({ code: proc.exitCode, text: stderrTail })),
            Effect.timeoutOption(EXIT_WAIT),
            Effect.map((waited) =>
              one(
                Option.isSome(waited)
                  ? endedWithoutResult(opts.id, waited.value.code, waited.value.text)
                  : endedWithoutResult(opts.id, -1, ""),
              ),
            ),
          )
        }),
      )

      return Stream.fromQueue(queue).pipe(
        Stream.tap((event) =>
          event.kind === "usage" ? Effect.sync(() => quota.record(event.usage)) : Effect.void,
        ),
        Stream.interruptWhen(deadline),
        Stream.concat(tail),
        // The group is killed when the run ends early (approval pause, budget cut); a no-op after a normal exit.
        Stream.ensuring(proc.kill()),
      )
    }),
  )

export const makeAcp = (opts: AcpOptions): Executor => {
  const quota = makeQuotaCounter(opts.id, opts.quotaWindowSeconds, opts.quotaSoftLimitTokens)
  return {
    id: opts.id,
    mapTier: () => ({ model: opts.model ?? "default" }),
    quota: () => Effect.sync(() => quota.status()),
    run: (task, ctx) => runAcp(opts, task, ctx, quota),
  }
}
