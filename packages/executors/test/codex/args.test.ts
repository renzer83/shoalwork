import { BotId, type ExecutorTask, SessionId, TaskId } from "@shoalwork/contracts"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  buildResumeArgs,
  buildRunArgs,
  CODEX_DEFAULT_MODEL,
  makeMapTier,
  sandboxFor,
} from "../../src/codex/args.js"

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

describe("codex args", () => {
  it("builds the run argv for permission mode readonly, with -- before the prompt", () => {
    expect(buildRunArgs(task({ permissionMode: "readonly" }), CWD, makeMapTier()("chat"))).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-C",
      CWD,
      "-s",
      "read-only",
      "-c",
      "approval_policy=never",
      "--",
      "fix the failing test",
    ])
  })

  it("maps permission modes edit and auto to workspace-write", () => {
    expect(sandboxFor("edit")).toBe("workspace-write")
    expect(sandboxFor("auto")).toBe("workspace-write")
  })

  it("maps permission mode bypass to danger-full-access and reads the sandbox from the task", () => {
    expect(sandboxFor("bypass")).toBe("danger-full-access")
    const argv = buildRunArgs(task({ permissionMode: "bypass" }), CWD, makeMapTier()("decision"))
    expect(argv[argv.indexOf("-s") + 1]).toBe("danger-full-access")
  })

  it("omits -m when no model is configured for the tier", () => {
    expect(makeMapTier()("light")).toEqual({ model: CODEX_DEFAULT_MODEL })
    expect(buildRunArgs(task(), CWD, makeMapTier()("heavy"))).not.toContain("-m")
  })

  it("maps every tier to the codex default when no models are configured", () => {
    const mapTier = makeMapTier()
    for (const tier of ["chat", "decision", "light", "heavy"] as const) {
      expect(mapTier(tier)).toEqual({ model: CODEX_DEFAULT_MODEL })
    }
  })

  it("passes -m with the configured model for the tier, and only for that tier", () => {
    const mapTier = makeMapTier({ chat: "gpt-5.6-luna" })
    expect(mapTier("chat")).toEqual({ model: "gpt-5.6-luna" })
    expect(mapTier("heavy")).toEqual({ model: CODEX_DEFAULT_MODEL })
    const withModel = buildRunArgs(task({ tier: "chat" }), CWD, mapTier("chat"))
    expect(withModel[withModel.indexOf("-m") + 1]).toBe("gpt-5.6-luna")
    expect(buildRunArgs(task({ tier: "heavy" }), CWD, mapTier("heavy"))).not.toContain("-m")
  })

  it("passes -m and model_reasoning_effort when the target sets them", () => {
    expect(buildRunArgs(task(), CWD, { model: "gpt-5.6-luna", effort: "high" })).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-C",
      CWD,
      "-m",
      "gpt-5.6-luna",
      "-s",
      "workspace-write",
      "-c",
      "approval_policy=never",
      "-c",
      "model_reasoning_effort=high",
      "--",
      "fix the failing test",
    ])
  })

  it("keeps a prompt that starts with a dash as the prompt, after --", () => {
    const argv = buildRunArgs(task({ prompt: "-x reply pong" }), CWD, makeMapTier()("heavy"))
    expect(argv.slice(-2)).toEqual(["--", "-x reply pong"])
  })

  it("builds the resume argv with --skip-git-repo-check before the session id, and -- before the prompt", () => {
    const sessionId = Schema.decodeUnknownSync(SessionId)("sess_abc")
    expect(buildResumeArgs(sessionId, "continue", makeMapTier()("heavy"))).toEqual([
      "exec",
      "resume",
      "--skip-git-repo-check",
      "sess_abc",
      "--json",
      "--",
      "continue",
    ])
    expect(buildResumeArgs(sessionId, "-x go", makeMapTier()("heavy")).slice(-2)).toEqual(["--", "-x go"])
  })

  it("passes -m before the session id on resume when the tier has a model, and omits it otherwise", () => {
    const sessionId = Schema.decodeUnknownSync(SessionId)("sess_abc")
    expect(buildResumeArgs(sessionId, "continue", { model: "gpt-5.6-luna" })).toEqual([
      "exec",
      "resume",
      "--skip-git-repo-check",
      "-m",
      "gpt-5.6-luna",
      "sess_abc",
      "--json",
      "--",
      "continue",
    ])
    expect(buildResumeArgs(sessionId, "continue", { model: CODEX_DEFAULT_MODEL })).not.toContain("-m")
  })
})
