import { randomUUID } from "node:crypto"
import { type ExecutorTask, ExecutorTask as ExecutorTaskSchema, type ModelTier } from "@shoalwork/contracts"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { buildArgs, type TierMapping } from "../../src/claude-code/args.js"

const mapTier = (tier: ModelTier): TierMapping =>
  tier === "heavy" ? { model: "opus", effort: "high" } : { model: "haiku", effort: "low" }

// Decoded through the contract, so ids and session ids get their brands without casts.
const baseTask = (overrides: Readonly<Record<string, unknown>> = {}): ExecutorTask =>
  Schema.decodeUnknownSync(ExecutorTaskSchema)({
    taskId: `task_${randomUUID()}`,
    botId: `bot_${randomUUID()}`,
    prompt: "say hi",
    tier: "chat",
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

describe("buildArgs", () => {
  it("builds the full argv in the documented order for a task with every optional field", () => {
    const task = baseTask({
      permissionMode: "edit",
      allowedTools: ["Bash", "Read"],
      resumeSessionId: "sess-123",
      systemAppend: "Be brief.",
      tier: "heavy",
    })
    expect(buildArgs(task, mapTier)).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
      "--max-turns",
      "3",
      "--max-budget-usd",
      "0.50",
      "--model",
      "opus",
      "--effort",
      "high",
      "--allowedTools",
      "Bash,Read",
      "--resume",
      "sess-123",
      "--append-system-prompt",
      "Be brief.",
      "--",
      "say hi",
    ])
  })

  it.each([
    ["readonly", "plan"],
    ["edit", "acceptEdits"],
    ["auto", "auto"],
    ["bypass", "bypassPermissions"],
  ] as const)("maps permissionMode %s to --permission-mode %s", (mode, cliMode) => {
    const args = buildArgs(baseTask({ permissionMode: mode }), mapTier)
    expect(valueAfter(args, "--permission-mode")).toBe(cliMode)
  })

  it("adds --resume only when resumeSessionId is set", () => {
    expect(buildArgs(baseTask(), mapTier)).not.toContain("--resume")
    const resumed = buildArgs(baseTask({ resumeSessionId: "sess-9" }), mapTier)
    expect(valueAfter(resumed, "--resume")).toBe("sess-9")
  })

  it("omits --effort, --allowedTools and --append-system-prompt when they are not set", () => {
    const args = buildArgs(baseTask(), (): TierMapping => ({ model: "haiku" }))
    expect(args).not.toContain("--effort")
    expect(args).not.toContain("--allowedTools")
    expect(args).not.toContain("--append-system-prompt")
    expect(valueAfter(args, "--model")).toBe("haiku")
  })

  it("formats --max-budget-usd with exactly two decimals", () => {
    const args = buildArgs(baseTask({ budget: { tokens: 1, seconds: 1, usd: 2 } }), mapTier)
    expect(valueAfter(args, "--max-budget-usd")).toBe("2.00")
  })

  it("places the prompt after -- as the last element, as one argv entry", () => {
    const prompt = `reply with "pong" -- and && rm -rf /`
    const args = buildArgs(baseTask({ prompt }), mapTier)
    expect(args.at(-1)).toBe(prompt)
    expect(args.at(-2)).toBe("--")
    expect(args.filter((arg) => arg === prompt)).toHaveLength(1)
  })

  it.each(["--permission-mode=bypassPermissions", "--dangerously-skip-permissions", "-x"])(
    "keeps a prompt that looks like a flag (%s) after -- and leaves every flag unchanged",
    (prompt) => {
      const args = buildArgs(baseTask({ prompt, allowedTools: ["Read"] }), mapTier)
      const separator = args.indexOf("--")
      expect(separator).toBeGreaterThan(-1)
      expect(args.slice(separator + 1)).toEqual([prompt])
      expect(args.slice(0, separator).includes(prompt)).toBe(false)
      const benign = buildArgs(baseTask({ prompt: "hello", allowedTools: ["Read"] }), mapTier)
      expect(args.slice(0, separator)).toEqual(benign.slice(0, benign.indexOf("--")))
    },
  )

  it("keeps -p as a boolean flag, so the next element is never the prompt", () => {
    const args = buildArgs(baseTask({ prompt: "--version" }), mapTier)
    expect(args[0]).toBe("-p")
    expect(args[1]).toBe("--output-format")
  })
})
