import { ExecutorTask, type PermissionMode } from "@shoalwork/contracts"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { buildArgs } from "../src/claude-code/args.js"
import { sandboxFor } from "../src/codex/args.js"

const task = (permissionMode: PermissionMode) =>
  Schema.decodeUnknownSync(ExecutorTask)({
    taskId: "task_00000000-0000-4000-8000-000000000001",
    botId: "bot_3f2a9c1e-7b4d-4e8a-9f10-2c6d5e8b7a41",
    prompt: "do it",
    tier: "light",
    allowedTools: ["Read"],
    permissionMode,
    maxTurns: 5,
    budget: { tokens: 1000, seconds: 60, usd: 1 },
  })

const modeFlag = (args: ReadonlyArray<string>) => args[args.indexOf("--permission-mode") + 1]
const mapTier = () => ({ model: "claude-haiku-5-5" })

describe("claude-code permission mode (T-057)", () => {
  it.each([
    ["readonly", "plan"],
    ["edit", "acceptEdits"],
    ["auto", "auto"],
    ["bypass", "dontAsk"],
  ] as const)("maps %s to the CLI flag %s", (mode, flag) => {
    expect(modeFlag(buildArgs(task(mode), mapTier))).toBe(flag)
  })

  it("never passes bypassPermissions, whatever the mode", () => {
    for (const mode of ["readonly", "edit", "auto", "bypass"] as const) {
      expect(buildArgs(task(mode), mapTier)).not.toContain("bypassPermissions")
    }
  })
})

describe("codex sandbox (T-057)", () => {
  it("uses workspace-write for edit and auto, read-only for readonly", () => {
    expect(sandboxFor("edit")).toBe("workspace-write")
    expect(sandboxFor("auto")).toBe("workspace-write")
    expect(sandboxFor("readonly")).toBe("read-only")
  })

  it("uses danger-full-access only for bypass", () => {
    expect(sandboxFor("bypass")).toBe("danger-full-access")
  })
})
