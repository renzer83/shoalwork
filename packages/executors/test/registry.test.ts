import { randomUUID } from "node:crypto"
import { it } from "@effect/vitest"
import {
  BotId,
  type ExecutorEvent,
  ExecutorId,
  ExecutorProtocolError,
  ExecutorSpawnError,
  ExecutorTask,
  NotFound,
} from "@shoalwork/contracts"
import { Tank, type TankContext, type TankShape } from "@shoalwork/tank"
import { Effect, Schema, type Scope, Stream } from "effect"
import { describe, expect } from "vitest"
import { type Executor, ExecutorRegistry, makeRegistry } from "../src/executor.js"

const id = (value: string) => Schema.decodeUnknownSync(ExecutorId)(value)

// The stubs never touch the Tank, so every method dies if it is ever reached.
const unusedTank: TankShape = {
  mode: "local",
  prepare: () => Effect.die("tank not used by this test"),
  exec: () => Effect.die("tank not used by this test"),
  spawnStream: () => Effect.die("tank not used by this test"),
  readFile: () => Effect.die("tank not used by this test"),
  writeFile: () => Effect.die("tank not used by this test"),
  release: () => Effect.die("tank not used by this test"),
}

const stub = (value: string, events: ReadonlyArray<ExecutorEvent>): Executor => ({
  id: id(value),
  run: () => Stream.fromIterable(events),
  mapTier: () => ({ model: "haiku" }),
  quota: () => Effect.succeed({ executor: id(value), usedRatio: 0, available: true }),
})

const task = Schema.decodeUnknownSync(ExecutorTask)({
  taskId: `task_${randomUUID()}`,
  botId: `bot_${randomUUID()}`,
  prompt: "say hi",
  tier: "chat",
  allowedTools: [],
  permissionMode: "readonly",
  maxTurns: 1,
  budget: { tokens: 1000, seconds: 60, usd: 0.1 },
})

const ctx: TankContext = {
  botId: Schema.decodeUnknownSync(BotId)(`bot_${randomUUID()}`),
  botName: "lead",
  cwd: "/tmp/unused",
  home: "/tmp/unused",
  env: {},
}

const runAll = <E>(stream: Stream.Stream<ExecutorEvent, E, Tank | Scope.Scope>) =>
  Stream.runCollect(stream).pipe(Effect.scoped, Effect.provideService(Tank, unusedTank))

const withRegistry = <A, E>(
  executors: ReadonlyArray<Executor>,
  body: (registry: typeof ExecutorRegistry.Service) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const registry = yield* ExecutorRegistry
    return yield* body(registry)
  }).pipe(Effect.provide(makeRegistry(executors)))

describe("ExecutorRegistry", () => {
  it.effect("get of an unknown id fails with NotFound", () =>
    withRegistry([stub("claude-code", [])], (registry) =>
      Effect.gen(function* () {
        const error = yield* registry.get(id("nope")).pipe(Effect.flip)
        expect(error).toBeInstanceOf(NotFound)
        expect(error.id).toBe("nope")
      }),
    ),
  )

  it.effect("list returns the registered ids in registration order", () =>
    withRegistry([stub("claude-code", []), stub("codex", [])], (registry) =>
      Effect.sync(() => {
        expect(registry.list()).toEqual(["claude-code", "codex"])
      }),
    ),
  )

  it.effect("a stream that ends without a terminal event gets error{protocol} at the end", () =>
    withRegistry([stub("claude-code", [{ kind: "started" }, { kind: "text", text: "half" }])], (registry) =>
      Effect.gen(function* () {
        const executor = yield* registry.get(id("claude-code"))
        const events = yield* runAll(executor.run(task, ctx))
        expect(events).toHaveLength(3)
        expect(events[2]).toEqual({
          kind: "error",
          code: "protocol",
          message: "executor stream ended without a terminal event",
        })
      }),
    ),
  )

  it.effect("a stream that already ends with done is passed through without an extra error", () =>
    withRegistry(
      [
        stub("claude-code", [
          { kind: "text", text: "ok" },
          { kind: "done", result: "ok", artifacts: [] },
        ]),
      ],
      (registry) =>
        Effect.gen(function* () {
          const executor = yield* registry.get(id("claude-code"))
          const events = yield* runAll(executor.run(task, ctx))
          expect(events.map((event) => event.kind)).toEqual(["text", "done"])
        }),
    ),
  )

  it.effect("a typed failure of the stream is propagated, not converted", () => {
    const failing: Executor = {
      ...stub("codex", []),
      run: () => Stream.fail(new ExecutorSpawnError({ executor: "codex", cause: "boom" })),
    }
    return withRegistry([failing], (registry) =>
      Effect.gen(function* () {
        const executor = yield* registry.get(id("codex"))
        const error = yield* runAll(executor.run(task, ctx)).pipe(Effect.flip)
        expect(error).toBeInstanceOf(ExecutorSpawnError)
        expect(error).not.toBeInstanceOf(ExecutorProtocolError)
      }),
    )
  })

  it("rejects two executors registered under the same id", () => {
    expect(() => makeRegistry([stub("codex", []), stub("codex", [])])).toThrow(/duplicate executor id/)
  })
})
