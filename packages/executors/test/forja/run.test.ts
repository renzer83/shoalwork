// The forja contract is UNVERIFIED (T-080): these tests run on a synthetic fixture, not on the real binary.
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { it } from "@effect/vitest"
import {
  BotId,
  type ExecutorEvent,
  ExecutorSpawnError,
  type ExecutorTask,
  TaskId,
} from "@shoalwork/contracts"
import { type RunningProcess, Tank, type TankContext, type TankShape } from "@shoalwork/tank"
import { Effect, Schema, Stream } from "effect"
import { describe, expect } from "vitest"
import { makeForja } from "../../src/forja/index.js"

const fixture = (name: string): ReadonlyArray<string> =>
  readFileSync(fileURLToPath(new URL(`../fixtures/forja/synthetic/${name}`, import.meta.url)), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")

const BIN = "forja"
const PROMPT = "fix the failing test"

const ctx: TankContext = {
  botId: Schema.decodeUnknownSync(BotId)("bot_00000000-0000-4000-8000-000000000001"),
  botName: "bot-a",
  cwd: "/tank/bot-a/work/step-1",
  home: "/tank/bot-a/home",
  env: { HOME: "/tank/bot-a/home" },
}

const task = (): ExecutorTask => ({
  taskId: Schema.decodeUnknownSync(TaskId)("task_00000000-0000-4000-8000-000000000002"),
  botId: Schema.decodeUnknownSync(BotId)("bot_00000000-0000-4000-8000-000000000001"),
  prompt: PROMPT,
  tier: "heavy",
  allowedTools: [],
  permissionMode: "edit",
  maxTurns: 10,
  budget: { tokens: 1_000_000, seconds: 600, usd: 10 },
})

const fakeProcess = (lines: ReadonlyArray<string>, exitCode = 0, stderr: ReadonlyArray<string> = []) => {
  const proc: RunningProcess = {
    pid: 4243,
    stdout: Stream.fromIterable(lines),
    stderr: Stream.fromIterable(stderr),
    exitCode: Effect.succeed(exitCode),
    writeStdin: () => Effect.void,
    closeStdin: () => Effect.void,
    kill: () => Effect.void,
  }
  return proc
}

// Records every argv handed to spawnStream and serves the given process.
const recordingTank = (proc: RunningProcess) => {
  const argvs: Array<ReadonlyArray<string>> = []
  const unused = () => Effect.die("tank not used by the forja executor")
  const shape: TankShape = {
    mode: "local",
    prepare: unused,
    exec: unused,
    spawnStream: (_ctx, cmd) =>
      Effect.sync(() => {
        argvs.push(cmd)
        return proc
      }),
    readFile: unused,
    writeFile: unused,
    writeHomeFile: unused,
    worktrees: unused,
    removeWorktree: unused,
    release: unused,
  }
  return { shape, argvs }
}

const collect = (run: ReturnType<typeof makeForja>["run"], shape: TankShape) =>
  Stream.runCollect(run(task(), ctx)).pipe(Effect.scoped, Effect.provideService(Tank, shape))

const kinds = (events: ReadonlyArray<ExecutorEvent>): ReadonlyArray<string> =>
  events.map((event) => event.kind)

describe("forja executor", () => {
  it.effect("reports available=false and refuses to run when the binary is absent", () =>
    Effect.gen(function* () {
      const executor = makeForja({ bin: BIN, onPath: () => false })
      const status = yield* executor.quota()
      expect(status.available).toBe(false)
      const { shape, argvs } = recordingTank(fakeProcess(fixture("success.ndjson")))
      const failure = yield* Effect.flip(collect(executor.run, shape))
      expect(failure).toBeInstanceOf(ExecutorSpawnError)
      expect(argvs).toEqual([])
    }),
  )

  it.effect("reports available=true when the binary is on the host", () =>
    Effect.gen(function* () {
      const executor = makeForja({ bin: BIN, onPath: (bin) => bin === BIN })
      const status = yield* executor.quota()
      expect(status).toEqual({ executor: "forja", usedRatio: 0, available: true })
    }),
  )

  it.effect("spawns forja run --json with the prompt last, after the -- separator", () =>
    Effect.gen(function* () {
      const { shape, argvs } = recordingTank(fakeProcess(fixture("success.ndjson")))
      yield* collect(makeForja({ bin: BIN, onPath: () => true }).run, shape)
      expect(argvs).toEqual([[BIN, "run", "--json", "--", PROMPT]])
    }),
  )

  it.effect("maps the synthetic stream to events and ends with done, ignoring unknown types", () =>
    Effect.gen(function* () {
      const { shape } = recordingTank(fakeProcess(fixture("success.ndjson")))
      const events = yield* collect(makeForja({ bin: BIN, onPath: () => true }).run, shape)
      expect(kinds(events)).toEqual(["started", "text", "command", "file_edit", "usage", "done"])
      expect(events[0]).toEqual({ kind: "started", sessionId: "forja-session-1" })
      expect(events[5]).toEqual({
        kind: "done",
        result: "fixed the clock",
        artifacts: [],
        sessionId: "forja-session-1",
      })
    }),
  )

  it.effect("ends with a protocol error when no line is recognized", () =>
    Effect.gen(function* () {
      const { shape } = recordingTank(fakeProcess(fixture("no-known-type.ndjson")))
      const events = yield* collect(makeForja({ bin: BIN, onPath: () => true }).run, shape)
      expect(events).toEqual([
        { kind: "error", code: "protocol", message: "forja output had no recognized event" },
      ])
    }),
  )

  it.effect("ends with an error when the process exits without a result", () =>
    Effect.gen(function* () {
      const { shape } = recordingTank(fakeProcess(fixture("success.ndjson").slice(0, 2), 2, ["boom"]))
      const events = yield* collect(makeForja({ bin: BIN, onPath: () => true }).run, shape)
      expect(kinds(events).at(-1)).toBe("error")
    }),
  )
})
