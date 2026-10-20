import {
  type ExecutorEvent,
  type ExecutorId,
  type ExecutorProtocolError,
  type ExecutorSpawnError,
  type ExecutorTask,
  type ModelTier,
  NotFound,
  type QuotaStatus,
} from "@shoalwork/contracts"
import type { Tank, TankContext } from "@shoalwork/tank"
import { Context, Effect, Layer, Ref, type Scope, Stream } from "effect"
import type { McpAttachment } from "./mcp-config.js"

export type Effort = "low" | "medium" | "high" | "xhigh" | "max"

// The Tank context of the run, plus the MCP servers the Bot should get (T-042). Without `mcp` nothing is attached.
export type ExecutorContext = TankContext & { readonly mcp?: McpAttachment }

export interface Executor {
  readonly id: ExecutorId
  readonly run: (
    task: ExecutorTask,
    ctx: ExecutorContext,
  ) => Stream.Stream<ExecutorEvent, ExecutorSpawnError | ExecutorProtocolError, Tank | Scope.Scope>
  readonly mapTier: (tier: ModelTier) => { readonly model: string; readonly effort?: Effort }
  readonly quota: () => Effect.Effect<QuotaStatus>
}

export class ExecutorRegistry extends Context.Service<
  ExecutorRegistry,
  {
    readonly get: (id: ExecutorId) => Effect.Effect<Executor, NotFound>
    readonly list: () => ReadonlyArray<ExecutorId>
  }
>()("@shoalwork/ExecutorRegistry") {}

const isTerminal = (event: ExecutorEvent): boolean => event.kind === "done" || event.kind === "error"

// Adapters must end with done|error; if one ends silently, the registry reports it as a protocol error.
const ensureTerminal = (
  source: Stream.Stream<ExecutorEvent, ExecutorSpawnError | ExecutorProtocolError, Tank | Scope.Scope>,
): Stream.Stream<ExecutorEvent, ExecutorSpawnError | ExecutorProtocolError, Tank | Scope.Scope> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const seen = yield* Ref.make(false)
      const missing = Stream.unwrap(
        Effect.map(
          Ref.get(seen),
          (ok): Stream.Stream<ExecutorEvent> =>
            ok
              ? Stream.empty
              : Stream.make({
                  kind: "error",
                  code: "protocol",
                  message: "executor stream ended without a terminal event",
                }),
        ),
      )
      return source.pipe(
        Stream.tap((event) => (isTerminal(event) ? Ref.set(seen, true) : Effect.void)),
        Stream.concat(missing),
      )
    }),
  )

// Wraps every executor's run so the terminal-event rule holds for all of them, whatever the adapter does.
const guard = (executor: Executor): Executor => ({
  id: executor.id,
  mapTier: executor.mapTier,
  quota: executor.quota,
  run: (task, ctx) => ensureTerminal(executor.run(task, ctx)),
})

export const makeRegistry = (executors: ReadonlyArray<Executor>): Layer.Layer<ExecutorRegistry> => {
  // Duplicate ids are a composition bug, caught when the layer is built.
  const byId = new Map<ExecutorId, Executor>()
  for (const executor of executors) {
    if (byId.has(executor.id)) throw new Error(`duplicate executor id: ${executor.id}`)
    byId.set(executor.id, guard(executor))
  }
  const ids: ReadonlyArray<ExecutorId> = executors.map((executor) => executor.id)
  return Layer.succeed(ExecutorRegistry, {
    get: (id) => {
      const executor = byId.get(id)
      return executor === undefined
        ? Effect.fail(new NotFound({ entity: "Executor", id }))
        : Effect.succeed(executor)
    },
    list: () => ids.slice(),
  })
}
