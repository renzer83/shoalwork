import { it } from "@effect/vitest"
import { Effect, Redacted } from "effect"
import { describe, expect } from "vitest"
import {
  build,
  collect,
  fakeTank,
  fixture,
  kinds,
  policyOf,
  scriptedFetch,
  sse,
  task,
  text,
  toolCallStream,
  toolcall,
} from "./harness.js"

describe("openai-compat run", () => {
  it.effect("text fixture yields started, text deltas, usage and done with the last text", () =>
    Effect.gen(function* () {
      const script = scriptedFetch([text])
      const { shape } = fakeTank()
      const events = yield* collect(build(script, policyOf("allow").policy), task(), shape)
      expect(kinds(events)).toEqual(["started", "text", "text", "usage", "done"])
      expect(events[0]).toEqual({ kind: "started", model: "qwen3:8b" })
      expect(events[3]).toMatchObject({ kind: "usage", usage: { tokensIn: 12, tokensOut: 2, usd: 0 } })
      expect(events.at(-1)).toEqual({ kind: "done", result: "pong", artifacts: [] })
    }),
  )

  it.effect("picks the model from task.model, then the tier table, then the default", () =>
    Effect.gen(function* () {
      const script = scriptedFetch([text])
      const { shape } = fakeTank()
      const executor = build(script, policyOf("allow").policy, { tiers: { heavy: { model: "big" } } })
      yield* collect(executor, task({ tier: "heavy" }), shape)
      yield* collect(executor, task({ tier: "heavy", model: "pinned" }), shape)
      yield* collect(executor, task({ tier: "light" }), shape)
      expect(script.requests.map((r) => r.body.model)).toEqual(["big", "pinned", "qwen3:8b"])
    }),
  )

  it.effect("runs the tool call in the Tank, sends the result back and finishes on the second round", () =>
    Effect.gen(function* () {
      const script = scriptedFetch([toolcall, text])
      const { shape, calls } = fakeTank()
      const { policy, seen } = policyOf("allow")
      const events = yield* collect(build(script, policy), task(), shape)
      expect(calls.exec).toEqual([["echo", "hi"]])
      expect(seen).toEqual([{ tool: "Bash", input: { command: "echo hi" } }])
      expect(kinds(events)).toEqual(["started", "usage", "command", "text", "text", "usage", "done"])
      expect(events[2]).toMatchObject({ kind: "command", cmd: "echo hi", exitCode: 0, output: "hi\n" })
      const second = script.requests[1]?.body.messages
      expect(second).toMatchObject([
        { role: "user" },
        { role: "assistant", tool_calls: [{ id: "call_abc", function: { name: "run_command" } }] },
        { role: "tool", tool_call_id: "call_abc", content: "exit code 0\nhi\n" },
      ])
    }),
  )

  it.effect("stops with max_turns when the model keeps asking for tools", () =>
    Effect.gen(function* () {
      const script = scriptedFetch([toolcall])
      const { shape } = fakeTank()
      const events = yield* collect(build(script, policyOf("allow").policy), task({ maxTurns: 2 }), shape)
      expect(script.requests).toHaveLength(2)
      expect(events.at(-1)).toMatchObject({ kind: "error", code: "max_turns" })
    }),
  )

  it.effect("supportsTools false sends no tools and ignores tool_calls in the answer", () =>
    Effect.gen(function* () {
      const script = scriptedFetch([toolcall])
      const { shape, calls } = fakeTank()
      const events = yield* collect(
        build(script, policyOf("allow").policy, { supportsTools: false }),
        task(),
        shape,
      )
      expect(script.requests[0]?.body.tools).toBeUndefined()
      expect(calls.exec).toEqual([])
      expect(events.at(-1)).toMatchObject({ kind: "done" })
    }),
  )

  it.live("a 429 is retried and the run completes", () =>
    Effect.gen(function* () {
      const script = scriptedFetch([() => sse("rate limited", 429), text])
      const { shape } = fakeTank()
      const events = yield* collect(build(script, policyOf("allow").policy), task(), shape)
      expect(script.requests).toHaveLength(2)
      expect(events.at(-1)).toMatchObject({ kind: "done", result: "pong" })
    }),
  )

  it.effect("a 401 ends with error auth and does not leak the key", () =>
    Effect.gen(function* () {
      const script = scriptedFetch([() => sse("invalid key sk-test-abc", 401)])
      const { shape } = fakeTank()
      const executor = build(script, policyOf("allow").policy, { apiKey: Redacted.make("sk-test-abc") })
      const events = yield* collect(executor, task(), shape)
      const last = events.at(-1)
      expect(last).toMatchObject({ kind: "error", code: "auth" })
      expect(JSON.stringify(events)).not.toContain("sk-test-abc")
      expect(script.requests[0]?.headers.authorization).toBe("Bearer sk-test-abc")
    }),
  )

  it.effect("an endpoint that reports no usage gets an estimate (chars/4) and a note", () =>
    Effect.gen(function* () {
      const noUsage = fixture("stream-text.sse")
        .split("\n\n")
        .filter((block) => !block.includes('"usage"'))
        .join("\n\n")
      const script = scriptedFetch([() => sse(noUsage), () => sse(noUsage)])
      const { shape } = fakeTank()
      const executor = build(script, policyOf("allow").policy)
      const events = yield* collect(executor, task(), shape)
      const usage = events.find((e) => e.kind === "usage")
      expect(usage?.kind === "usage" ? usage.usage.tokensIn : 0).toBeGreaterThan(0)
      expect(usage?.kind === "usage" ? usage.usage.tokensOut : 0).toBe(1)
      expect(events.filter((e) => e.kind === "thinking")).toHaveLength(1)
      expect(events.at(-1)).toMatchObject({ kind: "done" })
    }),
  )

  it.effect("reports budget when the tokens reported exceed the task budget", () =>
    Effect.gen(function* () {
      const script = scriptedFetch([text])
      const { shape } = fakeTank()
      const events = yield* collect(
        build(script, policyOf("allow").policy),
        task({ budget: { tokens: 10, seconds: 600, usd: 1 } }),
        shape,
      )
      expect(events.at(-1)).toMatchObject({ kind: "error", code: "budget" })
    }),
  )

  it.live("the wall-clock budget cuts a response that never ends", () =>
    Effect.gen(function* () {
      const never = () =>
        new Response(new ReadableStream<Uint8Array>({ start: () => undefined }), { status: 200 })
      const script = scriptedFetch([never])
      const { shape } = fakeTank()
      const events = yield* collect(
        build(script, policyOf("allow").policy),
        task({ budget: { tokens: 1000, seconds: 1, usd: 1 } }),
        shape,
      )
      expect(events.at(-1)).toMatchObject({ kind: "error", code: "budget" })
    }),
  )

  it.effect("a stream that ends with neither finish_reason nor [DONE] is a protocol error", () =>
    Effect.gen(function* () {
      const cut = 'data: {"choices":[{"delta":{"content":"par"}}]}\n\n'
      const script = scriptedFetch([() => sse(cut)])
      const { shape } = fakeTank()
      const events = yield* collect(build(script, policyOf("allow").policy), task(), shape)
      expect(events.at(-1)).toMatchObject({ kind: "error", code: "protocol" })
    }),
  )

  it.effect("[DONE] alone is enough to close a stream whose server sends no finish_reason", () =>
    Effect.gen(function* () {
      const body = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'
      const script = scriptedFetch([() => sse(body)])
      const { shape } = fakeTank()
      const events = yield* collect(build(script, policyOf("allow").policy), task(), shape)
      expect(events.at(-1)).toMatchObject({ kind: "done", result: "hi" })
    }),
  )

  it.effect("finish_reason length or content_filter is an error and no tool is executed", () =>
    Effect.gen(function* () {
      for (const reason of ["length", "content_filter"]) {
        const body = toolCallStream("run_command", '{"cmd":["rm","-rf","x"]}').replace(
          'tool_calls"}',
          `${reason}"}`,
        )
        const script = scriptedFetch([() => sse(body)])
        const { shape, calls } = fakeTank()
        const events = yield* collect(build(script, policyOf("allow").policy), task(), shape)
        expect(calls.exec).toEqual([])
        expect(events.at(-1)).toMatchObject({
          kind: "error",
          code: "unknown",
          message: expect.stringContaining(reason),
        })
      }
    }),
  )

  it.effect("an error chunk in the middle of the stream ends the run with that message", () =>
    Effect.gen(function* () {
      const body =
        'data: {"choices":[{"delta":{"content":"par"}}]}\n\ndata: {"error":{"message":"upstream overloaded"}}\n\n'
      const script = scriptedFetch([() => sse(body)])
      const { shape } = fakeTank()
      const events = yield* collect(build(script, policyOf("allow").policy), task(), shape)
      expect(events.at(-1)).toMatchObject({ kind: "error", code: "unknown", message: "upstream overloaded" })
    }),
  )

  it.effect("remembers that the server refused stream_options for the rest of the run", () =>
    Effect.gen(function* () {
      const refuse = () => sse('{"error":"stream_options is not supported"}', 400)
      const script = scriptedFetch([refuse, toolcall, text])
      const { shape } = fakeTank()
      yield* collect(build(script, policyOf("allow").policy), task(), shape)
      expect(script.requests.map((r) => r.body.stream_options !== undefined)).toEqual([true, false, false])
    }),
  )

  it.effect("finish_reason length on a plain text answer is still done, with the cut noted", () =>
    Effect.gen(function* () {
      const body =
        'data: {"choices":[{"delta":{"content":"partial answer"},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n'
      const script = scriptedFetch([() => sse(body)])
      const { shape } = fakeTank()
      const events = yield* collect(build(script, policyOf("allow").policy), task(), shape)
      expect(events.at(-1)).toEqual({ kind: "done", result: "partial answer", artifacts: [] })
      expect(events.some((e) => e.kind === "thinking" && e.text.includes("finish_reason length"))).toBe(true)
    }),
  )
})
