import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { BotId, type ExecutorTask, TaskId } from "@shoalwork/contracts"
import { type RunningProcess, Tank, type TankContext, type TankShape } from "@shoalwork/tank"
import { Effect, Schema, Stream } from "effect"
import { describe, expect } from "vitest"
import { makeCodexExecutor } from "../src/codex/index.js"
import type { ExecutorContext } from "../src/executor.js"
import type { McpAttachment } from "../src/mcp-config.js"

const OPERATOR_LINE = 'model = "operator-choice"'

const attachment: McpAttachment = {
  serverEntry: "/opt/shoalwork/packages/reef/dist/mcp.js",
  repo: "shoalwork",
  bot: "bot_42",
  api: "http://127.0.0.1:3000/",
  servers: [
    {
      name: "notes",
      transport: "stdio",
      command: "node",
      args: ["s.js"],
      envKeys: ["NOTES_TOKEN"],
      allowedTools: "*",
    },
  ],
}

const task: ExecutorTask = {
  taskId: Schema.decodeUnknownSync(TaskId)("task_00000000-0000-4000-8000-000000000002"),
  botId: Schema.decodeUnknownSync(BotId)(`bot_${randomUUID()}`),
  prompt: "do it",
  tier: "light",
  allowedTools: [],
  permissionMode: "edit",
  maxTurns: 3,
  budget: { tokens: 1000, seconds: 60, usd: 1 },
}

// The config.toml as codex would read it at the moment it starts.
const runAndSnapshot = (home: string, mcp: McpAttachment | undefined) => {
  const seen: Array<string> = []
  const proc: RunningProcess = {
    pid: 1,
    stdout: Stream.empty,
    stderr: Stream.empty,
    exitCode: Effect.succeed(0),
    writeStdin: () => Effect.void,
    closeStdin: () => Effect.void,
    kill: () => Effect.void,
  }
  const unused = () => Effect.die("unused")
  const tank: TankShape = {
    mode: "local",
    prepare: unused,
    exec: unused,
    spawnStream: () =>
      Effect.promise(async () => {
        seen.push(await readFile(join(home, ".codex", "config.toml"), "utf8"))
        return proc
      }),
    readFile: unused,
    writeFile: unused,
    writeHomeFile: unused,
    worktrees: unused,
    removeWorktree: unused,
    release: unused,
  }
  const ctx: TankContext & Pick<ExecutorContext, "mcp"> = {
    botId: task.botId,
    botName: "bot",
    cwd: join(home, "work"),
    home,
    env: { HOME: home, CODEX_HOME: join(home, ".codex") },
    ...(mcp === undefined ? {} : { mcp }),
  }
  const executor = makeCodexExecutor({ quotaWindowSeconds: 3600, quotaSoftLimitTokens: 1_000_000 })
  return Stream.runDrain(executor.run(task, ctx)).pipe(
    Effect.scoped,
    Effect.provideService(Tank, tank),
    Effect.as(seen),
  )
}

describe("codex MCP config across runs", () => {
  it.live("a run without a grant removes the servers and the reef table the run before left", () =>
    Effect.gen(function* () {
      const home = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "codex-revoke-")))
      yield* Effect.promise(async () => {
        await mkdir(join(home, ".codex"), { recursive: true })
        await writeFile(join(home, ".codex", "config.toml"), `${OPERATOR_LINE}\n`)
      })
      const first = yield* runAndSnapshot(home, attachment)
      expect(first[0]).toContain("[mcp_servers.notes]")
      expect(first[0]).toContain("[mcp_servers.reef]")
      const second = yield* runAndSnapshot(home, undefined)
      expect(second[0]).not.toContain("mcp_servers")
      expect(second[0]).not.toContain("shoalwork-mcp")
      expect(second[0]).toContain(OPERATOR_LINE)
      yield* Effect.promise(() => rm(home, { recursive: true, force: true }))
    }),
  )

  it.live("a run without a grant and without a config file writes nothing", () =>
    Effect.gen(function* () {
      const home = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "codex-revoke-")))
      yield* Effect.promise(() => mkdir(join(home, ".codex"), { recursive: true }))
      yield* Effect.promise(() => writeFile(join(home, ".codex", "config.toml"), `${OPERATOR_LINE}\n`))
      const seen = yield* runAndSnapshot(home, undefined)
      expect(seen[0]).toBe(`${OPERATOR_LINE}\n`)
      yield* Effect.promise(() => rm(home, { recursive: true, force: true }))
    }),
  )
})
