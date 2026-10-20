import { randomUUID } from "node:crypto"
import {
  type ExecutorTask,
  ExecutorTask as ExecutorTaskSchema,
  type ModelTier,
  SessionId,
} from "@shoalwork/contracts"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { buildArgs, buildChatArgs, buildWarmChatArgs, type TierMapping } from "../src/claude-code/args.js"
import {
  buildResumeArgs,
  buildRunArgs,
  CODEX_DEFAULT_MODEL,
  makeMapTier,
  targetFor,
} from "../src/codex/args.js"

const mapTier = (tier: ModelTier): TierMapping =>
  tier === "heavy" ? { model: "opus", effort: "high" } : { model: "haiku", effort: "low" }

const baseTask = (overrides: Readonly<Record<string, unknown>> = {}): ExecutorTask =>
  Schema.decodeUnknownSync(ExecutorTaskSchema)({
    taskId: `task_${randomUUID()}`,
    botId: `bot_${randomUUID()}`,
    prompt: "say hi",
    tier: "heavy",
    allowedTools: [],
    permissionMode: "readonly",
    maxTurns: 3,
    budget: { tokens: 1000, seconds: 60, usd: 0.5 },
    ...overrides,
  })

const valueAfter = (args: ReadonlyArray<string>, flag: string): string | undefined => {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

describe("claude-code argv honours the task's own model and effort", () => {
  it("buildArgs uses the task model and effort over the tier mapping", () => {
    const args = buildArgs(baseTask({ model: "claude-sonnet-5", effort: "low" }), mapTier)
    expect(valueAfter(args, "--model")).toBe("claude-sonnet-5")
    expect(valueAfter(args, "--effort")).toBe("low")
  })

  it("buildArgs falls back to the tier mapping when the task leaves model and effort open", () => {
    const args = buildArgs(baseTask(), mapTier)
    expect(valueAfter(args, "--model")).toBe("opus")
    expect(valueAfter(args, "--effort")).toBe("high")
  })

  it("buildChatArgs and buildWarmChatArgs use the task model", () => {
    const task = baseTask({ tier: "chat", model: "claude-haiku-5-5" })
    expect(valueAfter(buildChatArgs(task, mapTier), "--model")).toBe("claude-haiku-5-5")
    expect(valueAfter(buildWarmChatArgs(task, mapTier), "--model")).toBe("claude-haiku-5-5")
  })
})

describe("codex argv honours the task's own model and effort", () => {
  it("targetFor prefers the task model and effort", () => {
    const codexMap = makeMapTier({ heavy: "gpt-tier" })
    expect(targetFor(baseTask({ model: "gpt-task", effort: "medium" }), codexMap)).toEqual({
      model: "gpt-task",
      effort: "medium",
    })
  })

  it("targetFor uses the tier model when the task leaves it open", () => {
    expect(targetFor(baseTask(), makeMapTier({ heavy: "gpt-tier" }))).toEqual({ model: "gpt-tier" })
  })

  it("a task model on the run argv becomes -m; the codex default sentinel keeps -m off", () => {
    const withModel = buildRunArgs(baseTask({ model: "gpt-task" }), "/cwd", { model: "gpt-task" })
    expect(valueAfter(withModel, "-m")).toBe("gpt-task")
    const sentinel = buildRunArgs(baseTask({ model: CODEX_DEFAULT_MODEL }), "/cwd", {
      model: CODEX_DEFAULT_MODEL,
    })
    expect(sentinel).not.toContain("-m")
  })

  it("a task model on the resume argv becomes -m", () => {
    const sessionId = Schema.decodeUnknownSync(SessionId)("thread-9")
    const args = buildResumeArgs(sessionId, "continue", { model: "gpt-task" })
    expect(valueAfter(args, "-m")).toBe("gpt-task")
  })
})
