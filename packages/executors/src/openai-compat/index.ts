import type {
  ExecutorEvent,
  ExecutorId,
  ExecutorProtocolError,
  ExecutorSpawnError,
  ExecutorTask,
  ModelTier,
} from "@shoalwork/contracts"
import { Tank } from "@shoalwork/tank"
import { Duration, Effect, type Redacted, type Scope, Stream } from "effect"
import type { Executor, ExecutorContext } from "../executor.js"
import type { FetchLike } from "./client.js"
import { runLoop } from "./loop.js"
import type { OpenAICompatPolicy } from "./tools.js"

export type { FetchLike } from "./client.js"
export type { OpenAICompatPolicy } from "./tools.js"

export type OpenAICompatOptions = {
  readonly id: ExecutorId
  // Up to and including /v1, e.g. http://localhost:11434/v1 (Ollama), https://openrouter.ai/api/v1.
  readonly baseUrl: string
  // Sent as `Authorization: Bearer`; absent means the placeholder "ollama". Never logged or put in an error.
  readonly apiKey?: Redacted.Redacted<string>
  readonly defaultModel: string
  readonly tiers?: Partial<Record<ModelTier, { readonly model: string }>>
  // false: chat only, no tools are offered and tool_calls in the answer are ignored.
  readonly supportsTools: boolean
  // Judges every tool call (Read / Write / Bash of the Bot). `Policy.evaluate` of @shoalwork/policy fits.
  readonly policy: OpenAICompatPolicy
  readonly maxTokens?: number
  // Injected in tests; defaults to the global fetch.
  readonly fetch?: FetchLike
  // First step of the 429/5xx backoff; default 500 ms.
  readonly retryBase?: Duration.Input
}

const DEFAULT_MAX_TOKENS = 4096
const DEFAULT_RETRY_BASE: Duration.Input = "500 millis"

const isTerminal = (event: ExecutorEvent): boolean =>
  event.kind === "done" || event.kind === "error" || event.kind === "approval_needed"

const globalFetch: FetchLike = (url, init) => fetch(url, init)

const runOpenAICompat = (
  opts: OpenAICompatOptions,
  model: string,
  task: ExecutorTask,
  ctx: ExecutorContext,
): Stream.Stream<ExecutorEvent, ExecutorSpawnError | ExecutorProtocolError, Tank | Scope.Scope> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const tank = yield* Tank
      let secondsExpired = false
      // Wall-clock budget: when it fires the upstream is cut (aborting the request); `tail` reports it.
      const deadline = Effect.sleep(Duration.seconds(task.budget.seconds)).pipe(
        Effect.andThen(
          Effect.sync(() => {
            secondsExpired = true
          }),
        ),
      )
      const tail: Stream.Stream<ExecutorEvent> = Stream.unwrap(
        Effect.sync(
          (): Stream.Stream<ExecutorEvent> =>
            secondsExpired
              ? Stream.make({
                  kind: "error",
                  code: "budget",
                  message: `wall-clock budget of ${task.budget.seconds}s exceeded`,
                })
              : Stream.empty,
        ),
      )
      let ended = false
      const events = runLoop(
        {
          executor: opts.id,
          fetcher: opts.fetch ?? globalFetch,
          baseUrl: opts.baseUrl,
          apiKey: opts.apiKey,
          model,
          supportsTools: opts.supportsTools,
          maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
          retryBase: opts.retryBase ?? DEFAULT_RETRY_BASE,
          tools: { tank, ctx, botId: task.botId, policy: opts.policy, mode: task.permissionMode },
        },
        task,
      )
      return events.pipe(
        Stream.tap((event) =>
          Effect.sync(() => {
            if (isTerminal(event)) ended = true
          }),
        ),
        Stream.takeUntil(isTerminal),
        Stream.interruptWhen(deadline),
        Stream.concat(Stream.unwrap(Effect.sync(() => (ended ? Stream.empty : tail)))),
      )
    }),
  )

export const makeOpenAICompat = (opts: OpenAICompatOptions): Executor => {
  const mapTier = (tier: ModelTier) => ({ model: opts.tiers?.[tier]?.model ?? opts.defaultModel })
  return {
    id: opts.id,
    mapTier,
    // No local counter yet, as in the other executors.
    quota: () => Effect.succeed({ executor: opts.id, usedRatio: 0, available: true }),
    run: (task, ctx) => runOpenAICompat(opts, task.model ?? mapTier(task.tier).model, task, ctx),
  }
}
