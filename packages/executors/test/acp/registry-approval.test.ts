import { it } from "@effect/vitest"
import { type ExecutorEvent, ExecutorId } from "@shoalwork/contracts"
import { Tank, type TankShape } from "@shoalwork/tank"
import { Effect, Schema, Stream } from "effect"
import { describe, expect } from "vitest"
import { type Executor, ExecutorRegistry, makeRegistry } from "../../src/executor.js"
import { ctx, task } from "./harness.js"

const id = Schema.decodeUnknownSync(ExecutorId)("pausing")
const events: ReadonlyArray<ExecutorEvent> = [
  { kind: "started" },
  { kind: "approval_needed", action: { tool: "Bash", input: {} }, risk: "external" },
]
const pausing: Executor = {
  id,
  run: () => Stream.fromIterable(events),
  mapTier: () => ({ model: "m" }),
  quota: () => Effect.succeed({ executor: id, usedRatio: 0, available: true }),
}
const unused = () => Effect.die("tank not used by this test")
const anyTank: TankShape = {
  mode: "local",
  prepare: unused,
  exec: unused,
  spawnStream: unused,
  readFile: unused,
  writeFile: unused,
  writeHomeFile: unused,
  release: unused,
  worktrees: unused,
  removeWorktree: unused,
}

describe("registry and approval_needed", () => {
  it.effect("a run that ends at approval_needed gets no protocol error after it", () =>
    Effect.gen(function* () {
      const registry = yield* ExecutorRegistry
      const executor = yield* registry.get(id)
      const seen = yield* Stream.runCollect(executor.run(task(), ctx)).pipe(
        Effect.scoped,
        Effect.provideService(Tank, anyTank),
      )
      expect(seen).toEqual(events)
    }).pipe(Effect.provide(makeRegistry([pausing]))),
  )
})
