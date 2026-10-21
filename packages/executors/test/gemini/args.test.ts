import { BotId, type ExecutorTask, SessionId, TaskId } from "@shoalwork/contracts"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { approvalModeFor, buildArgs, defaultMapTier } from "../../src/gemini/args.js"

const task = (overrides: Partial<ExecutorTask> = {}): ExecutorTask => ({
  taskId: Schema.decodeUnknownSync(TaskId)("task_00000000-0000-4000-8000-000000000002"),
  botId: Schema.decodeUnknownSync(BotId)("bot_00000000-0000-4000-8000-000000000001"),
  prompt: "fix the failing test",
  tier: "heavy",
  allowedTools: [],
  permissionMode: "edit",
  maxTurns: 10,
  budget: { tokens: 100_000, seconds: 600, usd: 1 },
  ...overrides,
})

const flagValue = (argv: ReadonlyArray<string>, flag: string): string | undefined => {
  const index = argv.indexOf(flag)
  return index === -1 ? undefined : argv[index + 1]
}

describe("gemini args", () => {
  it("builds the readonly argv with the prompt bound to --prompt=", () => {
    expect(buildArgs(task({ permissionMode: "readonly" }), defaultMapTier)).toEqual([
      "--prompt=fix the failing test",
      "--output-format",
      "stream-json",
      "--approval-mode",
      "plan",
      "-m",
      "gemini-pro-latest",
    ])
  })

  it("maps each permission mode to its approval mode", () => {
    expect(approvalModeFor("readonly")).toBe("plan")
    expect(approvalModeFor("edit")).toBe("auto_edit")
    expect(approvalModeFor("auto")).toBe("auto_edit")
    expect(approvalModeFor("bypass")).toBe("yolo")
    expect(flagValue(buildArgs(task({ permissionMode: "bypass" }), defaultMapTier), "--approval-mode")).toBe(
      "yolo",
    )
  })

  it("adds --resume with the session id only when the task resumes a session", () => {
    const sessionId = Schema.decodeUnknownSync(SessionId)("6f1c2a4e-1111-4a2b-9c3d-000000000001")
    const resumed = buildArgs(task({ resumeSessionId: sessionId, prompt: "continue" }), defaultMapTier)
    expect(resumed.slice(-1)).toEqual(["--resume=6f1c2a4e-1111-4a2b-9c3d-000000000001"])
    expect(resumed).not.toContain("--session-id")
    expect(buildArgs(task(), defaultMapTier).some((arg) => arg.startsWith("--resume"))).toBe(false)
  })

  it("keeps a prompt that starts with a flag inside its own --prompt= value", () => {
    const flagPrompt = buildArgs(task({ prompt: "--permission-mode=bypassPermissions" }), defaultMapTier)
    expect(flagPrompt[0]).toBe("--prompt=--permission-mode=bypassPermissions")
    expect(flagPrompt).not.toContain("--permission-mode=bypassPermissions")
    const dashPrompt = buildArgs(task({ prompt: "-x" }), defaultMapTier)
    expect(dashPrompt[0]).toBe("--prompt=-x")
    expect(dashPrompt).not.toContain("-x")
  })

  it("maps chat, decision and light to the flash model and heavy to the pro model", () => {
    expect(defaultMapTier("chat")).toEqual({ model: "gemini-flash-latest" })
    expect(defaultMapTier("decision")).toEqual({ model: "gemini-flash-latest" })
    expect(defaultMapTier("light")).toEqual({ model: "gemini-flash-latest" })
    expect(defaultMapTier("heavy")).toEqual({ model: "gemini-pro-latest" })
  })

  it("uses the task's own model over the tier mapping", () => {
    expect(flagValue(buildArgs(task({ tier: "heavy", model: "gemini-2.5-pro" }), defaultMapTier), "-m")).toBe(
      "gemini-2.5-pro",
    )
    expect(flagValue(buildArgs(task({ tier: "chat" }), defaultMapTier), "-m")).toBe("gemini-flash-latest")
  })
})
