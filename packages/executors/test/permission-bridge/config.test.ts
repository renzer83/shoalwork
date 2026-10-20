import { randomUUID } from "node:crypto"
import { type ExecutorTask, ExecutorTask as ExecutorTaskSchema, type ModelTier } from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { buildArgs, PERMISSION_PROMPT_TOOL, type TierMapping } from "../../src/claude-code/args.js"
import { claudeMcpJson, type McpAttachment, validateAttachment } from "../../src/mcp-config.js"
import { parseBridgeArgs, redact } from "../../src/permission-bridge/index.js"
import { PERMISSION_TOOL_REF } from "../../src/permission-bridge/server.js"

const mapTier = (_tier: ModelTier): TierMapping => ({ model: "opus", effort: "high" })

const task = (permissionMode: string): ExecutorTask =>
  Schema.decodeUnknownSync(ExecutorTaskSchema)({
    taskId: `task_${randomUUID()}`,
    botId: `bot_${randomUUID()}`,
    prompt: "push the branch",
    tier: "heavy",
    allowedTools: ["Bash"],
    permissionMode,
    maxTurns: 3,
    budget: { tokens: 1000, seconds: 60, usd: 0.5 },
  })

const valueAfter = (args: ReadonlyArray<string>, flag: string): string | undefined => {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

const attachment: McpAttachment = {
  serverEntry: "/srv/reef/dist/mcp.js",
  repo: "shoalwork",
  bot: "bot_x",
  api: "http://127.0.0.1:3000/",
  permissionBridge: { serverEntry: "/srv/executors/dist/permission-bridge/index.js" },
}

describe("buildArgs with the permission bridge", () => {
  it("auto + bridge + MCP config: default mode and the prompt tool, prompt still last after --", () => {
    const args = buildArgs(task("auto"), mapTier, "none", "/home/mcp.json", true)
    expect(valueAfter(args, "--permission-mode")).toBe("default")
    expect(valueAfter(args, "--permission-prompt-tool")).toBe(PERMISSION_PROMPT_TOOL)
    expect(PERMISSION_PROMPT_TOOL).toBe(PERMISSION_TOOL_REF)
    expect(args.slice(-2)).toEqual(["--", "push the branch"])
  })

  it("off by default: auto stays auto and no prompt tool is passed", () => {
    const args = buildArgs(task("auto"), mapTier, "none", "/home/mcp.json")
    expect(valueAfter(args, "--permission-mode")).toBe("auto")
    expect(args).not.toContain("--permission-prompt-tool")
  })

  it("never for a task that is not auto, and never without the MCP config file", () => {
    expect(buildArgs(task("edit"), mapTier, "none", "/home/mcp.json", true)).not.toContain(
      "--permission-prompt-tool",
    )
    const noFile = buildArgs(task("auto"), mapTier, "none", undefined, true)
    expect(noFile).not.toContain("--permission-prompt-tool")
    expect(valueAfter(noFile, "--permission-mode")).toBe("auto")
  })
})

describe("claudeMcpJson with the bridge", () => {
  it("adds the permission-bridge server next to reef, token by reference only", () => {
    const parsed = JSON.parse(claudeMcpJson(attachment)) as {
      mcpServers: Record<string, { command: string; args: Array<string>; env: Record<string, string> }>
    }
    expect(Object.keys(parsed.mcpServers)).toEqual(["reef", "permission-bridge"])
    expect(parsed.mcpServers["permission-bridge"]).toEqual({
      command: "node",
      args: [
        "/srv/executors/dist/permission-bridge/index.js",
        "--api",
        "http://127.0.0.1:3000/",
        "--mode",
        "inline",
      ],
      env: { SHOALWORK_API_TOKEN: `\${SHOALWORK_API_TOKEN}` },
    })
  })

  it("leaves the document unchanged when no bridge is attached, and rejects a relative entry", async () => {
    const { permissionBridge: _none, ...plain } = attachment
    expect(Object.keys(JSON.parse(claudeMcpJson(plain)).mcpServers)).toEqual(["reef"])
    const bad = { ...attachment, permissionBridge: { serverEntry: "dist/index.js" } }
    const error = await Effect.runPromise(Effect.flip(validateAttachment("claude-code", bad)))
    expect(error.reason).toContain("permissionBridge.serverEntry")
  })
})

describe("app-permission-bridge argv", () => {
  it("parses --api and --mode, defaulting to inline", () => {
    expect(parseBridgeArgs(["--api", "http://127.0.0.1:3000"])).toEqual({
      kind: "run",
      api: "http://127.0.0.1:3000/",
      mode: "inline",
    })
    expect(parseBridgeArgs(["--api", "https://core.example", "--mode", "resume"])).toMatchObject({
      mode: "resume",
    })
  })

  it("refuses a token in argv, a bad mode, a missing or non-http api and unknown flags", () => {
    expect(parseBridgeArgs(["--token", "x"])).toMatchObject({ kind: "error" })
    expect(parseBridgeArgs(["--api", "http://h", "--mode", "fast"])).toMatchObject({ kind: "error" })
    expect(parseBridgeArgs([])).toMatchObject({ kind: "error" })
    expect(parseBridgeArgs(["--api", "file:///etc/passwd"])).toMatchObject({ kind: "error" })
    expect(parseBridgeArgs(["--api", "http://h", "--x"])).toMatchObject({ kind: "error" })
    expect(parseBridgeArgs(["--help"])).toEqual({ kind: "help" })
  })

  it("redacts the secret and bearer headers from diagnostics", () => {
    const secret = ["s3", "value"].join("-")
    expect(redact(`boom ${secret} Bearer abc`, secret)).toBe("boom [redacted] Bearer [redacted]")
  })
})
