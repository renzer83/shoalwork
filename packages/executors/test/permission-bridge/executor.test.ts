import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { BotId, ExecutorTask as ExecutorTaskSchema } from "@shoalwork/contracts"
import { type RunningProcess, Tank, type TankShape } from "@shoalwork/tank"
import { Effect, Schema, Stream } from "effect"
import { describe, expect } from "vitest"
import { makeClaudeCode } from "../../src/claude-code/index.js"
import type { ExecutorContext } from "../../src/executor.js"

const task = Schema.decodeUnknownSync(ExecutorTaskSchema)({
  taskId: `task_${randomUUID()}`,
  botId: `bot_${randomUUID()}`,
  prompt: "push",
  tier: "heavy",
  allowedTools: [],
  permissionMode: "auto",
  maxTurns: 3,
  budget: { tokens: 1000, seconds: 60, usd: 0.25 },
})

type Attachment = "with-bridge" | "without-bridge" | "none"

const run = (bridge: boolean | undefined, attachment: Attachment = "with-bridge") =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), "bridge-exec-")),
      catch: (cause) => new Error(String(cause)),
    }),
    (home) =>
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
          writeHomeFile: () => Effect.die("unused"),
          worktrees: () => Effect.die("unused"),
          removeWorktree: () => Effect.die("unused"),
          release: () => Effect.die("unused"),
        }
        const ctx: ExecutorContext = {
          botId: Schema.decodeUnknownSync(BotId)(`bot_${randomUUID()}`),
          botName: "dev",
          cwd: join(home, "work"),
          home,
          env: { HOME: home, PATH: "/usr/bin" },
          ...(attachment === "none"
            ? {}
            : {
                mcp: {
                  serverEntry: "/opt/reef/dist/mcp.js",
                  repo: "shoalwork",
                  bot: "bot_42",
                  api: "http://127.0.0.1:3000/",
                  ...(attachment === "with-bridge"
                    ? { permissionBridge: { serverEntry: "/opt/executors/dist/permission-bridge/index.js" } }
                    : {}),
                },
              }),
        }
        const executor = makeClaudeCode(bridge === undefined ? {} : { permissionBridge: bridge })
        yield* Stream.runCollect(executor.run(task, ctx)).pipe(
          Effect.scoped,
          Effect.provideService(Tank, tank),
        )
        const config =
          attachment === "none"
            ? undefined
            : (JSON.parse(yield* Effect.promise(() => readFile(join(home, "mcp.json"), "utf8"))) as {
                mcpServers: Record<string, unknown>
              })
        return { cmd: spawned[0] ?? [], servers: Object.keys(config?.mcpServers ?? {}) }
      }),
    (home) => Effect.promise(() => rm(home, { recursive: true, force: true })),
  )

describe("makeClaudeCode permissionBridge option", () => {
  it.effect("on: the config carries the bridge server and the CLI is pointed at its tool", () =>
    Effect.gen(function* () {
      const { cmd, servers } = yield* run(true)
      expect(servers).toEqual(["reef", "permission-bridge"])
      expect(cmd[cmd.indexOf("--permission-prompt-tool") + 1]).toBe("mcp__permission-bridge__approve")
      expect(cmd[cmd.indexOf("--permission-mode") + 1]).toBe("default")
    }),
  )

  it.effect("off (the default): no bridge server, no prompt tool, auto stays auto", () =>
    Effect.gen(function* () {
      for (const option of [undefined, false]) {
        const { cmd, servers } = yield* run(option)
        expect(servers).toEqual(["reef"])
        expect(cmd).not.toContain("--permission-prompt-tool")
        expect(cmd[cmd.indexOf("--permission-mode") + 1]).toBe("auto")
      }
    }),
  )

  it.effect("on, but the attachment has no bridge: plain auto, no prompt tool", () =>
    Effect.gen(function* () {
      const { cmd, servers } = yield* run(true, "without-bridge")
      expect(servers).toEqual(["reef"])
      expect(cmd).not.toContain("--permission-prompt-tool")
      expect(cmd[cmd.indexOf("--permission-mode") + 1]).toBe("auto")
    }),
  )

  it.effect("on, but the run has no MCP attachment at all: plain auto, no prompt tool", () =>
    Effect.gen(function* () {
      const { cmd, servers } = yield* run(true, "none")
      expect(servers).toEqual([])
      expect(cmd).not.toContain("--permission-prompt-tool")
      expect(cmd).not.toContain("default")
      expect(cmd[cmd.indexOf("--permission-mode") + 1]).toBe("auto")
    }),
  )
})
