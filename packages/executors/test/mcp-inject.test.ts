import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { BotId, type ExecutorTask, ExecutorTask as ExecutorTaskSchema } from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import { describe, expect } from "vitest"
import { buildArgs } from "../src/claude-code/args.js"
import { defaultMapTier } from "../src/claude-code/index.js"
import type { ExecutorContext } from "../src/executor.js"
import type { McpAttachment } from "../src/mcp-config.js"
import { mcpConfigFor } from "../src/mcp-config.js"
import {
  claudeServerEntries,
  codexServerBlock,
  isInjectable,
  type McpInject,
  mcpDeniedTools,
  mcpEnvNames,
  stripManagedServers,
  withManagedServers,
} from "../src/mcp-inject.js"

const stdio: McpInject = {
  name: "files",
  transport: "stdio",
  command: "node",
  args: ["server.js", "--root", "/srv"],
  envKeys: ["FILES_TOKEN"],
  allowedTools: ["read", "list"],
}
const remote: McpInject = {
  name: "remote",
  transport: "http",
  url: "https://mcp.example/mcp",
  bearerEnv: "REMOTE_TOKEN",
  allowedTools: "*",
}
const SECRET = ["super", "secret", "value"].join("-")

const attachment: McpAttachment = {
  serverEntry: "/opt/shoalwork/packages/reef/dist/mcp.js",
  repo: "shoalwork",
  bot: "bot_42",
  api: "http://127.0.0.1:3000/",
  servers: [stdio, remote],
}

const withHome = <A, E>(body: (home: string) => Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "mcp-inject-test-"))),
    body,
    (home) => Effect.promise(() => rm(home, { recursive: true, force: true })),
  )

const ctxIn = (home: string): ExecutorContext => ({
  botId: Schema.decodeUnknownSync(BotId)(`bot_${randomUUID()}`),
  botName: "dev",
  cwd: join(home, "work"),
  home,
  env: { HOME: home, CODEX_HOME: join(home, ".codex"), PATH: "/usr/bin", FILES_TOKEN: SECRET },
  mcp: attachment,
})

describe("claude injection", () => {
  it("builds stdio and http entries that name env vars, never values", () => {
    const entries = claudeServerEntries([stdio, remote])
    expect(entries).toEqual({
      files: {
        command: "node",
        args: ["server.js", "--root", "/srv"],
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the CLI expands this reference at launch
        env: { FILES_TOKEN: "${FILES_TOKEN}" },
      },
      remote: {
        type: "http",
        url: "https://mcp.example/mcp",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the CLI expands this reference at launch
        headers: { Authorization: "Bearer ${REMOTE_TOKEN}" },
      },
    })
  })

  it("derives the env var names", () => {
    expect(mcpEnvNames([stdio, remote])).toEqual(["FILES_TOKEN", "REMOTE_TOKEN"])
  })

  it("never pre-approves an MCP tool: there is no allowed list to derive, only denials", () => {
    const withKnown: McpInject = { ...stdio, knownTools: ["read", "list", "write", "delete"] }
    expect(mcpDeniedTools([withKnown, remote])).toEqual(["mcp__files__write", "mcp__files__delete"])
    // "*" denies nothing and an explicit list without knownTools cannot be turned into denials.
    expect(mcpDeniedTools([remote, stdio])).toEqual([])
  })

  it("does not inject a server with an empty tool list, a tool name that carries a comma or a reserved name", () => {
    expect(isInjectable({ ...stdio, allowedTools: [] })).toBe(false)
    expect(isInjectable({ ...stdio, allowedTools: ["read,Bash"] })).toBe(false)
    expect(isInjectable({ ...stdio, allowedTools: ["a b"] })).toBe(false)
    expect(isInjectable({ ...stdio, knownTools: ["x,Bash"] })).toBe(false)
    expect(isInjectable({ ...stdio, name: "reef" })).toBe(false)
    expect(isInjectable({ ...stdio, name: "permission-bridge" })).toBe(false)
    expect(Object.keys(claudeServerEntries([{ ...stdio, allowedTools: ["read,Bash"] }]))).toEqual([])
  })

  it("rejects env expansion inside command, args and url", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the point of the test
    const expansion = "${HOME}"
    expect(isInjectable({ ...stdio, command: `node${expansion}` })).toBe(false)
    expect(isInjectable({ ...stdio, args: [`--root=${expansion}`] })).toBe(false)
    expect(isInjectable({ ...remote, url: `https://x.example/${expansion}` })).toBe(false)
  })

  it("drops a server whose name or env key could break the config", () => {
    const bad: ReadonlyArray<McpInject> = [
      { ...stdio, name: 'x"y' },
      { ...stdio, envKeys: ["lower"] },
      { ...remote, url: "file:///etc/passwd" },
    ]
    expect(claudeServerEntries(bad)).toEqual({})
    expect(mcpDeniedTools(bad)).toEqual([])
  })

  it.effect("mcpConfigFor writes the Bot servers next to the reef, with no secret value in the file", () =>
    withHome((home) =>
      Effect.gen(function* () {
        const path = yield* mcpConfigFor("claude-code", ctxIn(home))
        const text = yield* Effect.promise(() => readFile(path, "utf8"))
        const doc: unknown = JSON.parse(text)
        expect(doc).toMatchObject({
          mcpServers: { reef: { command: "node" }, files: { command: "node" }, remote: { type: "http" } },
        })
        expect(text).not.toContain(SECRET)
      }),
    ),
  )
})

describe("codex injection", () => {
  it("builds TOML tables with env_vars and bearer_token_env_var", () => {
    const block = codexServerBlock([stdio, remote])
    expect(block).toContain("[mcp_servers.files]")
    expect(block).toContain('args = ["server.js", "--root", "/srv"]')
    expect(block).toContain('env_vars = ["FILES_TOKEN"]')
    expect(block).toContain("[mcp_servers.remote]")
    expect(block).toContain('bearer_token_env_var = "REMOTE_TOKEN"')
    expect(block).toContain('url = "https://mcp.example/mcp"')
  })

  it("limits a server to the Bot's tools with enabled_tools, and leaves it out for *", () => {
    const block = codexServerBlock([stdio, remote])
    expect(block).toContain('enabled_tools = ["read", "list"]')
    expect(block.split("enabled_tools").length - 1).toBe(1)
  })

  it("leaves a file alone when the managed region never closes", () => {
    const broken = 'model = "x"\n# shoalwork-mcp-begin\n[mcp_servers.mine]\ncommand = "x"\n'
    expect(stripManagedServers(broken)).toBe(broken)
  })

  it("replaces the managed region whole and leaves the rest of the file alone", () => {
    const first = withManagedServers(stripManagedServers('model = "x"\n'), codexServerBlock([stdio, remote]))
    const second = withManagedServers(stripManagedServers(first), codexServerBlock([remote]))
    expect(second).toContain('model = "x"')
    expect(second).not.toContain("mcp_servers.files")
    expect(second).toContain("mcp_servers.remote")
    expect(withManagedServers(stripManagedServers(second), codexServerBlock([remote]))).toBe(second)
    expect(stripManagedServers(second).trim()).toBe('model = "x"')
  })

  it.effect(
    "mcpConfigFor writes the reef table and the managed tables into the Bot CODEX_HOME, twice the same",
    () =>
      withHome((home) =>
        Effect.gen(function* () {
          const ctx = ctxIn(home)
          const path = yield* mcpConfigFor("codex", ctx)
          const once = yield* Effect.promise(() => readFile(path, "utf8"))
          yield* mcpConfigFor("codex", ctx)
          const twice = yield* Effect.promise(() => readFile(path, "utf8"))
          expect(twice).toBe(once)
          expect(once).toContain("[mcp_servers.reef]")
          expect(once).toContain("[mcp_servers.files]")
          expect(once).not.toContain(SECRET)
        }),
      ),
  )
})

describe("claude args", () => {
  it("passes the denied MCP tools as --disallowedTools and nothing MCP in --allowedTools", () => {
    const task: ExecutorTask = Schema.decodeUnknownSync(ExecutorTaskSchema)({
      taskId: `task_${randomUUID()}`,
      botId: `bot_${randomUUID()}`,
      prompt: "p",
      tier: "light",
      allowedTools: ["Read"],
      permissionMode: "auto",
      maxTurns: 2,
      budget: { tokens: 100, seconds: 10, usd: 0.1 },
    })
    const args = buildArgs(task, defaultMapTier, "none", "/home/mcp.json", true, [
      "mcp__files__write",
      "mcp__files__write",
    ])
    expect(args[args.indexOf("--disallowedTools") + 1]).toBe("mcp__files__write")
    const allowed = args[args.indexOf("--allowedTools") + 1] ?? ""
    expect(
      allowed.split(",").filter((tool) => tool.startsWith("mcp__") && !tool.startsWith("mcp__reef__")),
    ).toEqual([])
    expect(args.at(-2)).toBe("--")
  })
})
