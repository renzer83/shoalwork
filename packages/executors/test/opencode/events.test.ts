import { it } from "@effect/vitest"
import type { Budget, ExecutorEvent } from "@shoalwork/contracts"
import { Effect, Exit, Schema } from "effect"
import { describe, expect } from "vitest"
import { makeOpencodeMapper, OpencodeLine, type OpencodeMapper } from "../../src/opencode/events.js"

const BUDGET: Budget = { tokens: 1_000_000, seconds: 600, usd: 10 }

const line = (raw: unknown) => Schema.decodeUnknownSync(OpencodeLine)(raw)

const feed = (mapper: OpencodeMapper, raws: ReadonlyArray<unknown>) =>
  Effect.forEach(raws, (raw) => mapper.push(line(raw))).pipe(Effect.map((batches) => batches.flat()))

const SESSION = "ses_0001"

const textLine = (text: string) => ({
  type: "text",
  timestamp: 1,
  sessionID: SESSION,
  part: { id: "p1", type: "text", text },
})

const finishLine = (
  input: number,
  output: number,
  cache?: { read: number; write: number },
  cost?: number,
) => ({
  type: "step_finish",
  timestamp: 2,
  sessionID: SESSION,
  part: {
    id: "p2",
    type: "step-finish",
    reason: "stop",
    tokens: { total: input + output, input, output, reasoning: 0, cache: cache ?? { read: 0, write: 0 } },
    ...(cost === undefined ? {} : { cost }),
  },
})

const toolLine = (tool: string, status: string, input: unknown) => ({
  type: "tool_use",
  timestamp: 3,
  sessionID: SESSION,
  part: { type: "tool", tool, callID: "c1", state: { status, input, output: "ok" } },
})

describe("opencode events", () => {
  it.effect("announces the session once and maps text and step usage", () =>
    Effect.gen(function* () {
      const mapper = makeOpencodeMapper(BUDGET)
      const events = yield* feed(mapper, [
        { type: "step_start", timestamp: 0, sessionID: SESSION, part: { type: "step-start" } },
        textLine("pong"),
        finishLine(11498, 49, { read: 8960, write: 12 }, 0.002),
      ])
      expect(events).toEqual([
        { kind: "started", sessionId: SESSION },
        { kind: "text", text: "pong" },
        {
          kind: "usage",
          usage: {
            tokensIn: 11498,
            tokensOut: 49,
            cacheRead: 8960,
            cacheWrite: 12,
            usd: 0.002,
            seconds: 0,
          },
        },
      ])
      expect(mapper.finished()).toBe(false)
    }),
  )

  it.effect("maps a completed bash tool to tool_call and command", () =>
    Effect.gen(function* () {
      const mapper = makeOpencodeMapper(BUDGET)
      const events = yield* feed(mapper, [toolLine("bash", "completed", { command: "echo tool-probe-ok" })])
      expect(events).toEqual([
        { kind: "started", sessionId: SESSION },
        {
          kind: "tool_call",
          call: { tool: "bash", input: { command: "echo tool-probe-ok" } },
          status: "completed",
        },
        { kind: "command", cmd: "echo tool-probe-ok" },
      ])
    }),
  )

  it.effect("maps a completed write to file_edit by filePath; a failed one only as a failed tool call", () =>
    Effect.gen(function* () {
      const mapper = makeOpencodeMapper(BUDGET)
      const done = yield* feed(mapper, [
        toolLine("write", "completed", { content: "hi\n", filePath: "probe.txt" }),
      ])
      expect(done).toContainEqual({ kind: "file_edit", path: "probe.txt" })
      const failed = yield* feed(makeOpencodeMapper(BUDGET), [
        toolLine("write", "error", { filePath: "x.txt" }),
      ])
      expect(failed).toEqual([
        { kind: "started", sessionId: SESSION },
        { kind: "tool_call", call: { tool: "write", input: { filePath: "x.txt" } }, status: "failed" },
      ])
    }),
  )

  it.effect("ends the run with a terminal error on an error line and ignores what follows", () =>
    Effect.gen(function* () {
      const mapper = makeOpencodeMapper(BUDGET)
      const events = yield* feed(mapper, [
        {
          type: "error",
          timestamp: 4,
          sessionID: SESSION,
          error: { name: "UnknownError", data: { message: "boom" } },
        },
        textLine("late"),
      ])
      expect(events.at(-1)).toEqual({ kind: "error", code: "unknown", message: "boom" })
      expect(events.filter((event) => event.kind === "error")).toHaveLength(1)
      expect(mapper.finished()).toBe(true)
      expect(mapper.finish()).toEqual([])
    }),
  )

  it.effect("finish() yields done with the last text and the session, once", () =>
    Effect.gen(function* () {
      const mapper = makeOpencodeMapper(BUDGET)
      yield* feed(mapper, [textLine("first"), textLine("done")])
      const finished: ReadonlyArray<ExecutorEvent> = mapper.finish()
      expect(finished).toEqual([{ kind: "done", result: "done", artifacts: [], sessionId: SESSION }])
      expect(mapper.finish()).toEqual([])
    }),
  )

  it.effect("cuts the run with error budget when the tokens exceed the task budget", () =>
    Effect.gen(function* () {
      const mapper = makeOpencodeMapper({ tokens: 100, seconds: 600, usd: 10 })
      const events = yield* feed(mapper, [finishLine(90, 20)])
      expect(events.map((event) => event.kind)).toEqual(["started", "usage", "error"])
      expect(events.at(-1)).toEqual({
        kind: "error",
        code: "budget",
        message: "token budget of 100 exceeded",
      })
      expect(mapper.finished()).toBe(true)
    }),
  )

  it.effect("skips line types it does not map", () =>
    Effect.gen(function* () {
      const mapper = makeOpencodeMapper(BUDGET)
      const events = yield* feed(mapper, [{ type: "some_future_type", timestamp: 5, sessionID: SESSION }])
      expect(events).toEqual([{ kind: "started", sessionId: SESSION }])
    }),
  )

  it.effect("fails with a protocol error when a known line does not fit its shape", () =>
    Effect.gen(function* () {
      const mapper = makeOpencodeMapper(BUDGET)
      const exit = yield* Effect.exit(
        mapper.push(line({ type: "step_finish", sessionID: SESSION, part: {} })),
      )
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )
})
