import { BotId, type ExecutorTask, SessionId, TaskId } from "@shoalwork/contracts"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  buildRunArgs,
  isProviderModel,
  makeMapTier,
  permissionFor,
  targetFor,
} from "../../src/opencode/args.js"

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

const CWD = "/tank/bot/work/step-1"
const MODELS = {
  chat: "ollama/qwen3",
  decision: "zai-coding-plan/glm-5.3-flash",
  light: "zai-coding-plan/glm-5.3-flash",
  heavy: "zai-coding-plan/glm-5.3",
} as const

describe("opencode args", () => {
  it("builds the run argv with --auto and -- before the prompt", () => {
    const target = targetFor(task(), makeMapTier(MODELS))
    expect(buildRunArgs(task(), CWD, target)).toEqual([
      "run",
      "--format",
      "json",
      "--auto",
      "--dir",
      CWD,
      "-m",
      "zai-coding-plan/glm-5.3",
      "--",
      "fix the failing test",
    ])
  })

  it("keeps --auto for every permission mode, readonly included (the rule lives in opencode.json)", () => {
    for (const permissionMode of ["readonly", "edit", "auto", "bypass"] as const) {
      const argv = buildRunArgs(task({ permissionMode }), CWD, targetFor(task(), makeMapTier(MODELS)))
      expect(argv).toContain("--auto")
    }
  })

  it("adds --variant from the effort, and the task's effort wins over the tier's", () => {
    const lowTier = (): { readonly model: string; readonly effort: "low" } => ({
      model: "ollama/qwen3",
      effort: "low",
    })
    const withTaskEffort = task({ effort: "high" })
    const overridden = buildRunArgs(withTaskEffort, CWD, targetFor(withTaskEffort, lowTier))
    expect(overridden[overridden.indexOf("--variant") + 1]).toBe("high")
    const fromTier = buildRunArgs(task(), CWD, targetFor(task(), lowTier))
    expect(fromTier[fromTier.indexOf("--variant") + 1]).toBe("low")
    expect(buildRunArgs(task(), CWD, { model: "ollama/qwen3" })).not.toContain("--variant")
  })

  it("passes -s with the session id before -- on resume", () => {
    const sessionId = Schema.decodeUnknownSync(SessionId)("ses_abc123")
    const argv = buildRunArgs(task({ resumeSessionId: sessionId, prompt: "continue" }), CWD, {
      model: "ollama/qwen3",
    })
    expect(argv.slice(-4)).toEqual(["-s", "ses_abc123", "--", "continue"])
  })

  it("uses the task's model over the tier model, and the tier model otherwise", () => {
    const mapTier = makeMapTier(MODELS)
    expect(targetFor(task({ tier: "chat" }), mapTier).model).toBe("ollama/qwen3")
    expect(targetFor(task({ tier: "chat", model: "ollama/llama3" }), mapTier).model).toBe("ollama/llama3")
  })

  it("keeps a prompt that starts with a dash as the prompt, after --", () => {
    const argv = buildRunArgs(task({ prompt: "-x reply pong" }), CWD, { model: "ollama/qwen3" })
    expect(argv.slice(-2)).toEqual(["--", "-x reply pong"])
  })

  it("denies edit and bash only for readonly; other modes write no rule", () => {
    expect(permissionFor("readonly")).toEqual({ edit: "deny", bash: "deny" })
    expect(permissionFor("edit")).toBeUndefined()
    expect(permissionFor("auto")).toBeUndefined()
    expect(permissionFor("bypass")).toBeUndefined()
  })

  it("accepts provider/model and refuses anything else", () => {
    expect(isProviderModel("zai-coding-plan/glm-5.3")).toBe(true)
    expect(isProviderModel("ollama/qwen3")).toBe(true)
    expect(isProviderModel("glm-5.3")).toBe(false)
    expect(isProviderModel("/qwen3")).toBe(false)
    expect(isProviderModel("ollama/")).toBe(false)
    expect(isProviderModel("ollama/qwen 3")).toBe(false)
    expect(isProviderModel("")).toBe(false)
  })
})
