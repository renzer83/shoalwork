import { randomUUID } from "node:crypto"
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import {
  BotId,
  type ExecutorEvent,
  type ExecutorTask,
  ExecutorTask as ExecutorTaskSchema,
} from "@shoalwork/contracts"
import { type RunningProcess, Tank, type TankShape } from "@shoalwork/tank"
import { Effect, Schema, Stream } from "effect"
import { describe, expect } from "vitest"
import { buildArgs, REEF_MCP_TOOLS } from "../src/claude-code/args.js"
import { defaultMapTier, makeClaudeCode } from "../src/claude-code/index.js"
import { mergeMcpTable, reefTomlBlock } from "../src/codex/args.js"
import type { ExecutorContext } from "../src/executor.js"
import { claudeMcpJson, type McpAttachment, McpConfigError, mcpConfigFor } from "../src/mcp-config.js"

const attachment: McpAttachment = {
  serverEntry: "/opt/shoalwork/packages/reef/dist/mcp.js",
  repo: "shoalwork",
  bot: "bot_42",
  api: "http://127.0.0.1:3000/",
}

const baseTask = (overrides: Record<string, unknown> = {}): ExecutorTask =>
  Schema.decodeUnknownSync(ExecutorTaskSchema)({
    taskId: `task_${randomUUID()}`,
    botId: `bot_${randomUUID()}`,
    prompt: "find the indexer",
    tier: "light",
    allowedTools: [],
    permissionMode: "readonly",
    maxTurns: 4,
    budget: { tokens: 1000, seconds: 60, usd: 0.25 },
    ...overrides,
  })

// A throwaway Bot home per test. The Bot's files never touch the operator's HOME.
const withHome = <A, E>(body: (home: string) => Effect.Effect<A, E>): Effect.Effect<A, E | Error> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), "reef-mcp-test-")),
      catch: (cause) => new Error(String(cause)),
    }),
    body,
    (home) => Effect.promise(() => rm(home, { recursive: true, force: true })),
  )

const ctxIn = (home: string, extra: Partial<ExecutorContext> = {}): ExecutorContext => ({
  botId: Schema.decodeUnknownSync(BotId)(`bot_${randomUUID()}`),
  botName: "lead",
  cwd: join(home, "work"),
  home,
  env: { HOME: home, CODEX_HOME: join(home, ".codex"), PATH: "/usr/bin" },
  mcp: attachment,
  ...extra,
})

describe("claude MCP config document", () => {
  it("is valid JSON with absolute paths and only the token reference", () => {
    const doc: unknown = JSON.parse(claudeMcpJson(attachment))
    expect(doc).toEqual({
      mcpServers: {
        reef: {
          command: "node",
          args: [
            "/opt/shoalwork/packages/reef/dist/mcp.js",
            "--repo",
            "shoalwork",
            "--bot",
            "bot_42",
            "--api",
            "http://127.0.0.1:3000/",
          ],
          // biome-ignore lint/suspicious/noTemplateCurlyInString: the CLI expands this reference at launch
          env: { SHOALWORK_API_TOKEN: "${SHOALWORK_API_TOKEN}" },
        },
      },
    })
  })

  it.effect("mcpConfigFor writes mcp.json into the Bot home and returns its path", () =>
    withHome((home) =>
      Effect.gen(function* () {
        const path = yield* mcpConfigFor("claude-code", ctxIn(home))
        expect(path).toBe(join(home, "mcp.json"))
        const written: unknown = JSON.parse(yield* Effect.promise(() => readFile(path, "utf8")))
        expect(written).toMatchObject({ mcpServers: { reef: { command: "node" } } })
      }),
    ),
  )
})

describe("mcpConfigFor validation", () => {
  it.effect("rejects a relative server entry before writing anything", () =>
    withHome((home) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          mcpConfigFor("claude-code", ctxIn(home, { mcp: { ...attachment, serverEntry: "dist/mcp.js" } })),
        )
        expect(error).toBeInstanceOf(McpConfigError)
        expect(error.reason).toBe("serverEntry must be an absolute path")
      }),
    ),
  )

  it.effect("rejects a non-http api url", () =>
    withHome((home) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          mcpConfigFor("codex", ctxIn(home, { mcp: { ...attachment, api: "file:///etc/passwd" } })),
        )
        expect(error.reason).toBe("api must be an http or https URL")
      }),
    ),
  )

  it.effect("fails when the run context carries no attachment", () =>
    withHome((home) =>
      Effect.gen(function* () {
        const ctx: ExecutorContext = {
          botId: Schema.decodeUnknownSync(BotId)(`bot_${randomUUID()}`),
          botName: "lead",
          cwd: home,
          home,
          env: {},
        }
        const error = yield* Effect.flip(mcpConfigFor("claude-code", ctx))
        expect(error.reason).toBe("no MCP attachment on the run context")
      }),
    ),
  )
})

describe("codex config.toml merge", () => {
  const block = reefTomlBlock(
    [
      "/opt/shoalwork/packages/reef/dist/mcp.js",
      "--repo",
      "shoalwork",
      "--bot",
      "bot_42",
      "--api",
      "http://127.0.0.1:3000/",
    ],
    "node",
    "SHOALWORK_API_TOKEN",
  )

  it("renders the reef table with the token named by env_vars, not its value", () => {
    expect(block).toContain("[mcp_servers.reef]")
    expect(block).toContain('env_vars = ["SHOALWORK_API_TOKEN"]')
    expect(block).not.toContain("tok_")
  })

  it("merging twice gives the same text and a single reef table", () => {
    const once = mergeMcpTable("", block)
    const twice = mergeMcpTable(once, block)
    expect(twice).toBe(once)
    expect(twice.split("[mcp_servers.reef]")).toHaveLength(2)
  })

  it("keeps other tables and replaces a stale reef table with its sub-tables", () => {
    const existing = [
      'model = "gpt-5"',
      "",
      "[profiles.fast]",
      'model = "x"',
      "",
      "[mcp_servers.reef]",
      'command = "old"',
      "",
      "[mcp_servers.reef.env]",
      'OLD = "1"',
      "",
      "[mcp_servers.other]",
      'command = "keep"',
      "",
    ].join("\n")
    const merged = mergeMcpTable(existing, block)
    expect(merged).toContain('model = "gpt-5"')
    expect(merged).toContain("[profiles.fast]")
    expect(merged).toContain("[mcp_servers.other]")
    expect(merged).not.toContain('command = "old"')
    expect(merged).not.toContain("OLD")
    expect(merged.split("[mcp_servers.reef]")).toHaveLength(2)
    expect(mergeMcpTable(merged, block)).toBe(merged)
  })

  it.effect("mcpConfigFor(codex) writes the merged config.toml under the Bot's CODEX_HOME", () =>
    withHome((home) =>
      Effect.gen(function* () {
        const ctx = ctxIn(home)
        const path = yield* mcpConfigFor("codex", ctx)
        yield* mcpConfigFor("codex", ctx)
        expect(path).toBe(join(home, ".codex", "config.toml"))
        const text = yield* Effect.promise(() => readFile(path, "utf8"))
        expect(text.split("[mcp_servers.reef]")).toHaveLength(2)
        expect(text).toContain('args = ["/opt/shoalwork/packages/reef/dist/mcp.js"')
      }),
    ),
  )
})

describe("claude-code argv with an attached MCP config", () => {
  it("passes only the attached config and keeps the prompt after --", () => {
    const args = buildArgs(
      baseTask({ prompt: "--permission-mode=bypassPermissions" }),
      defaultMapTier,
      "none",
      "/home/mcp.json",
    )
    expect(args).toContain("--strict-mcp-config")
    expect(args[args.indexOf("--mcp-config") + 1]).toBe("/home/mcp.json")
    expect(args).not.toContain('{"mcpServers":{}}')
    expect(args.slice(-2)).toEqual(["--", "--permission-mode=bypassPermissions"])
  })

  it("keeps the empty MCP set when no config is attached", () => {
    const args = buildArgs(baseTask(), defaultMapTier)
    expect(args[args.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}')
  })
})

describe("claude-code run with an attached MCP config", () => {
  it.effect("spawns the CLI with --mcp-config pointing at the file written for the run", () =>
    withHome((home) =>
      Effect.gen(function* () {
        const spawned: Array<ReadonlyArray<string>> = []
        const tank: TankShape = {
          mode: "local",
          prepare: () => Effect.die("unused"),
          exec: () => Effect.die("unused"),
          spawnStream: (_ctx, cmd): Effect.Effect<RunningProcess> => {
            spawned.push(cmd)
            return Effect.succeed({
              pid: 1,
              stdout: Stream.empty,
              stderr: Stream.empty,
              exitCode: Effect.succeed(0),
              writeStdin: () => Effect.void,
              closeStdin: () => Effect.void,
              kill: () => Effect.void,
            })
          },
          readFile: () => Effect.die("unused"),
          writeFile: () => Effect.die("unused"),
          worktrees: () => Effect.die("unused"),
          removeWorktree: () => Effect.die("unused"),
          release: () => Effect.die("unused"),
        }
        const events: ReadonlyArray<ExecutorEvent> = yield* Stream.runCollect(
          makeClaudeCode().run(baseTask(), ctxIn(home)),
        ).pipe(Effect.scoped, Effect.provideService(Tank, tank))
        expect(events.some((event) => event.kind === "error")).toBe(true)
        const cmd = spawned[0] ?? []
        expect(cmd[cmd.indexOf("--mcp-config") + 1]).toBe(join(home, "mcp.json"))
        expect(cmd).toContain("--strict-mcp-config")
        expect(cmd).not.toContain('{"mcpServers":{}}')
      }),
    ),
  )
})

describe("claude-code allowedTools with an attached MCP config", () => {
  it("adds the three reef tools when the task list is empty", () => {
    const args = buildArgs(baseTask({ allowedTools: [] }), defaultMapTier, "none", "/home/mcp.json")
    expect(args[args.indexOf("--allowedTools") + 1]).toBe(
      "mcp__reef__search_code,mcp__reef__search_memory,mcp__reef__read_chunk",
    )
  })

  it("appends the reef tools to the task list without duplicates", () => {
    const args = buildArgs(
      baseTask({ allowedTools: ["Bash", "mcp__reef__search_code"] }),
      defaultMapTier,
      "none",
      "/home/mcp.json",
    )
    expect(args[args.indexOf("--allowedTools") + 1]).toBe(
      "Bash,mcp__reef__search_code,mcp__reef__search_memory,mcp__reef__read_chunk",
    )
    expect(REEF_MCP_TOOLS).toHaveLength(3)
  })

  it("leaves the task list alone when no config is attached", () => {
    const args = buildArgs(baseTask({ allowedTools: ["Bash"] }), defaultMapTier)
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("Bash")
    expect(args.join(" ")).not.toContain("mcp__reef__")
  })
})

describe("reef MCP config files are written safely", () => {
  it.effect("writes mcp.json with mode 0600", () =>
    withHome((home) =>
      Effect.gen(function* () {
        const path = yield* mcpConfigFor("claude-code", ctxIn(home))
        const info = yield* Effect.promise(() => stat(path))
        expect(info.mode & 0o777).toBe(0o600)
      }),
    ),
  )

  it.effect("writes config.toml with mode 0600", () =>
    withHome((home) =>
      Effect.gen(function* () {
        const path = yield* mcpConfigFor("codex", ctxIn(home))
        const info = yield* Effect.promise(() => stat(path))
        expect(info.mode & 0o777).toBe(0o600)
      }),
    ),
  )

  it.effect("refuses a symlink planted where mcp.json goes and leaves its target untouched", () =>
    withHome((home) =>
      Effect.gen(function* () {
        const victim = join(home, "victim.txt")
        yield* Effect.promise(() => writeFile(victim, "KEEP"))
        yield* Effect.promise(() => symlink(victim, join(home, "mcp.json")))
        const error = yield* Effect.flip(mcpConfigFor("claude-code", ctxIn(home)))
        expect(error.reason).toBe("refuses to write through a symlink")
        expect(yield* Effect.promise(() => readFile(victim, "utf8"))).toBe("KEEP")
        expect((yield* Effect.promise(() => lstat(join(home, "mcp.json")))).isSymbolicLink()).toBe(true)
      }),
    ),
  )

  it.effect("refuses a symlink planted where config.toml goes and leaves its target untouched", () =>
    withHome((home) =>
      Effect.gen(function* () {
        const codexHome = join(home, ".codex")
        yield* Effect.promise(() => mkdir(codexHome, { recursive: true }))
        const victim = join(home, "victim.toml")
        yield* Effect.promise(() => writeFile(victim, "KEEP = true\n"))
        yield* Effect.promise(() => symlink(victim, join(codexHome, "config.toml")))
        const error = yield* Effect.flip(mcpConfigFor("codex", ctxIn(home)))
        expect(error.reason).toBe("refuses to write through a symlink")
        expect(yield* Effect.promise(() => readFile(victim, "utf8"))).toBe("KEEP = true\n")
      }),
    ),
  )
})

describe("repo and bot names reach the config only through the allowlist", () => {
  it.effect("rejects a repo name with shell metacharacters", () =>
    withHome((home) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          mcpConfigFor("claude-code", ctxIn(home, { mcp: { ...attachment, repo: "shoal;rm -rf" } })),
        )
        expect(error.reason).toBe("repo has characters outside the allowlist")
      }),
    ),
  )

  it.effect("rejects a bot name with a backtick", () =>
    withHome((home) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          mcpConfigFor("codex", ctxIn(home, { mcp: { ...attachment, bot: "bot`id" } })),
        )
        expect(error.reason).toBe("bot has characters outside the allowlist")
      }),
    ),
  )

  it.effect("accepts names within the allowlist", () =>
    withHome((home) =>
      Effect.gen(function* () {
        const path = yield* mcpConfigFor(
          "claude-code",
          ctxIn(home, { mcp: { ...attachment, repo: "org/repo.v2:main-x" } }),
        )
        expect(path).toBe(join(home, "mcp.json"))
      }),
    ),
  )
})
