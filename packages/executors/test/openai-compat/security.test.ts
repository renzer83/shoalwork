import { it } from "@effect/vitest"
import type { ToolCall } from "@shoalwork/contracts"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { shellLine } from "../../src/openai-compat/tools.js"
import {
  build,
  collect,
  fakeTank,
  policyOf,
  scriptedFetch,
  sse,
  task,
  text,
  toolCallStream,
  toolcall,
} from "./harness.js"

describe("openai-compat tools", () => {
  it.effect("readonly offers only read_file and answers write_file with an error result", () =>
    Effect.gen(function* () {
      const script = scriptedFetch([
        () => sse(toolCallStream("write_file", '{"path":"a.txt","content":"x"}')),
        text,
      ])
      const { shape, calls } = fakeTank()
      const { policy, seen } = policyOf("allow")
      const events = yield* collect(build(script, policy), task({ permissionMode: "readonly" }), shape)
      const offered = script.requests[0]?.body.tools
      expect(offered).toMatchObject([{ function: { name: "read_file" } }])
      expect(calls.written).toEqual([])
      expect(seen).toEqual([])
      expect(events.find((e) => e.kind === "tool_call")).toMatchObject({ status: "failed" })
      expect(script.requests[1]?.body.messages).toMatchObject([
        { role: "user" },
        { role: "assistant" },
        { role: "tool", content: expect.stringContaining("error: tool") },
      ])
      expect(events.at(-1)).toMatchObject({ kind: "done" })
    }),
  )

  it.effect("edit mode writes the file through the Tank after the policy allows it", () =>
    Effect.gen(function* () {
      const script = scriptedFetch([
        () => sse(toolCallStream("write_file", '{"path":"src/a.txt","content":"hello"}')),
        text,
      ])
      const { shape, calls } = fakeTank()
      const { policy, seen } = policyOf("allow")
      const events = yield* collect(build(script, policy), task(), shape)
      expect(calls.written).toEqual([{ path: "/tank/bot-a/work/step-1/src/a.txt", content: "hello" }])
      expect(seen[0]).toMatchObject({ tool: "Write", resource: "/tank/bot-a/work/step-1/src/a.txt" })
      expect(events.find((e) => e.kind === "file_edit")).toEqual({
        kind: "file_edit",
        path: "/tank/bot-a/work/step-1/src/a.txt",
      })
    }),
  )

  it.effect("reads a file inside the cwd and returns its content to the model", () =>
    Effect.gen(function* () {
      const path = "/tank/bot-a/work/step-1/notes.txt"
      const script = scriptedFetch([() => sse(toolCallStream("read_file", '{"path":"notes.txt"}')), text])
      const { shape } = fakeTank({ files: { [path]: "line one" } })
      const events = yield* collect(build(script, policyOf("allow").policy), task(), shape)
      expect(events.find((e) => e.kind === "tool_call")).toMatchObject({ status: "completed" })
      expect(script.requests[1]?.body.messages).toMatchObject([
        { role: "user" },
        { role: "assistant" },
        { role: "tool", content: "line one" },
      ])
    }),
  )

  it.effect("refuses a path outside the cwd before the policy is asked", () =>
    Effect.gen(function* () {
      const script = scriptedFetch([
        () => sse(toolCallStream("read_file", '{"path":"../../../etc/passwd"}')),
        text,
      ])
      const { shape, calls } = fakeTank()
      const { policy, seen } = policyOf("allow")
      yield* collect(build(script, policy), task(), shape)
      expect(seen).toEqual([])
      expect(calls.read).toEqual([])
      expect(script.requests[1]?.body.messages).toMatchObject([
        { role: "user" },
        { role: "assistant" },
        { role: "tool", content: "error: path is outside the workspace" },
      ])
    }),
  )

  it.effect("a policy deny becomes an error result and nothing runs", () =>
    Effect.gen(function* () {
      const script = scriptedFetch([toolcall, text])
      const { shape, calls } = fakeTank()
      const events = yield* collect(build(script, policyOf("deny").policy), task(), shape)
      expect(calls.exec).toEqual([])
      expect(events.find((e) => e.kind === "tool_call")).toMatchObject({ status: "failed" })
      expect(events.at(-1)).toMatchObject({ kind: "done" })
    }),
  )

  it.effect("a policy ask ends the run with approval_needed and runs nothing", () =>
    Effect.gen(function* () {
      const script = scriptedFetch([toolcall, text])
      const { shape, calls } = fakeTank()
      const events = yield* collect(build(script, policyOf("ask").policy), task(), shape)
      expect(calls.exec).toEqual([])
      expect(script.requests).toHaveLength(1)
      expect(events.at(-1)).toMatchObject({
        kind: "approval_needed",
        action: { tool: "Bash", input: { command: "echo hi" } },
        risk: "write_local",
      })
    }),
  )

  it.effect("invalid tool arguments are an error result, not an exception", () =>
    Effect.gen(function* () {
      const script = scriptedFetch([() => sse(toolCallStream("run_command", "{oops")), text])
      const { shape, calls } = fakeTank()
      const events = yield* collect(build(script, policyOf("allow").policy), task(), shape)
      expect(calls.exec).toEqual([])
      expect(script.requests[1]?.body.messages).toMatchObject([
        { role: "user" },
        { role: "assistant" },
        { role: "tool", content: "error: arguments are not valid JSON" },
      ])
      expect(events.at(-1)).toMatchObject({ kind: "done" })
    }),
  )

  it.effect("truncates command output to 8 KB", () =>
    Effect.gen(function* () {
      const script = scriptedFetch([toolcall, text])
      const { shape } = fakeTank({
        exec: () => ({ exitCode: 0, stdout: "x".repeat(20_000), stderr: "", durationMs: 1, timedOut: false }),
      })
      const events = yield* collect(build(script, policyOf("allow").policy), task(), shape)
      const command = events.find((e) => e.kind === "command")
      expect(command?.kind === "command" ? command.output?.length : 0).toBeLessThan(8 * 1024 + 100)
      expect(command?.kind === "command" ? command.output : "").toContain(
        "[truncated: 11808 more characters]",
      )
    }),
  )

  it.effect("a policy that dies is a deny: nothing runs and the run goes on", () =>
    Effect.gen(function* () {
      const script = scriptedFetch([toolcall, text])
      const { shape, calls } = fakeTank()
      const dying = (_bot: unknown, _call: ToolCall) => Effect.die("policy exploded")
      const events = yield* collect(build(script, dying), task(), shape)
      expect(calls.exec).toEqual([])
      expect(events.find((e) => e.kind === "tool_call")).toMatchObject({ status: "failed" })
      expect(events.at(-1)).toMatchObject({ kind: "done" })
    }),
  )

  it.effect("a policy ask on write_file ends the run with approval_needed and writes nothing", () =>
    Effect.gen(function* () {
      const script = scriptedFetch([
        () => sse(toolCallStream("write_file", '{"path":"a.txt","content":"x"}')),
        text,
      ])
      const { shape, calls } = fakeTank()
      const events = yield* collect(build(script, policyOf("ask").policy), task(), shape)
      expect(calls.written).toEqual([])
      expect(script.requests).toHaveLength(1)
      expect(events.at(-1)).toMatchObject({
        kind: "approval_needed",
        action: { tool: "Write", resource: "/tank/bot-a/work/step-1/a.txt" },
      })
    }),
  )

  it.effect("passes the output cap to the Tank and tells the model when the command was cut", () =>
    Effect.gen(function* () {
      const script = scriptedFetch([toolcall, text])
      const { shape, calls } = fakeTank({
        exec: () => ({
          exitCode: 143,
          stdout: "y\n".repeat(10),
          stderr: "",
          durationMs: 1,
          timedOut: false,
          outputTruncated: true,
        }),
      })
      yield* collect(build(script, policyOf("allow").policy), task(), shape)
      expect(calls.execOpts[0]).toEqual({ maxOutputBytes: 8192, timeoutMs: 120_000 })
      const tool = script.requests[1]?.body.messages
      expect(tool).toMatchObject([
        {},
        {},
        { role: "tool", content: expect.stringContaining("the command was stopped") },
      ])
    }),
  )

  it.effect("reads a name that merely starts with two dots", () =>
    Effect.gen(function* () {
      const path = "/tank/bot-a/work/step-1/..hidden"
      const script = scriptedFetch([() => sse(toolCallStream("read_file", '{"path":"..hidden"}')), text])
      const { shape } = fakeTank({ files: { [path]: "dots" } })
      yield* collect(build(script, policyOf("allow").policy), task(), shape)
      expect(script.requests[1]?.body.messages).toMatchObject([{}, {}, { role: "tool", content: "dots" }])
    }),
  )

  it.effect("the policy judges the resolved path of a symlink inside the workspace", () =>
    Effect.gen(function* () {
      const link = "/tank/bot-a/work/step-1/link.txt"
      const real = "/tank/bot-a/work/step-1/secret/.env"
      const script = scriptedFetch([() => sse(toolCallStream("read_file", '{"path":"link.txt"}')), text])
      const { shape } = fakeTank({ files: { [real]: "KEY=1" }, links: { [link]: real } })
      const { policy, seen } = policyOf((call) => (String(call.resource).endsWith(".env") ? "deny" : "allow"))
      yield* collect(build(script, policy), task(), shape)
      expect(seen).toEqual([{ tool: "Read", input: { file_path: real }, resource: real }])
      expect(script.requests[1]?.body.messages).toMatchObject([
        {},
        {},
        { role: "tool", content: expect.stringContaining("denied") },
      ])
    }),
  )

  it.effect("a link that resolves outside the workspace reads like a missing file", () =>
    Effect.gen(function* () {
      const link = "/tank/bot-a/work/step-1/out.txt"
      const script = scriptedFetch([() => sse(toolCallStream("read_file", '{"path":"out.txt"}')), text])
      const { shape, calls } = fakeTank({
        files: { "/etc/passwd": "root" },
        links: { [link]: "/etc/passwd" },
      })
      const { policy, seen } = policyOf("allow")
      yield* collect(build(script, policy), task(), shape)
      expect(seen).toEqual([])
      expect(calls.read).toEqual([])
      expect(calls.exec.some((cmd) => cmd[0] === "wc")).toBe(false)
      expect(script.requests[1]?.body.messages).toMatchObject([
        {},
        {},
        { role: "tool", content: "error: not a readable regular file inside the workspace" },
      ])
    }),
  )

  it("shellLine quotes what a shell would split, expand or take as an assignment", () => {
    expect(shellLine(["git", "status"])).toBe("git status")
    expect(shellLine(["echo", "a b"])).toBe("echo 'a b'")
    expect(shellLine(["echo", "it's"])).toBe("echo 'it'\\''s'")
    expect(shellLine(["echo", "a;b"])).toBe("echo 'a;b'")
    expect(shellLine(["echo", "$(id)"])).toBe("echo '$(id)'")
    expect(shellLine(["echo", "`id`"])).toBe("echo '`id`'")
    expect(shellLine(["echo", ""])).toBe("echo ''")
    expect(shellLine(["FOO=1", "make"])).toBe("'FOO=1' make")
    expect(shellLine(["make", "--jobs=4"])).toBe("make --jobs=4")
  })
})
