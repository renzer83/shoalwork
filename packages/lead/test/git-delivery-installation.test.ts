import { it } from "@effect/vitest"
import { BotId } from "@shoalwork/contracts"
import { GhClientTest } from "@shoalwork/currents"
import type { ExecResult, TankContext, TankShape } from "@shoalwork/tank"
import { Effect, Redacted, Schema } from "effect"
import { describe, expect } from "vitest"
import { deliverCode } from "../src/git-delivery.js"
import { HEALTHY_EXEC, makeFakeTank } from "./support.js"

const BOT_ID = Schema.decodeUnknownSync(BotId)("bot_00000000-0000-5000-8000-000000000001")
const BRANCH = "bot/dev-demo/step_00000000-0000-4000-8000-000000000002"
const TASK_ID = "task_00000000-0000-4000-8000-000000000003"
const TOKEN = "ghs_installation_secret_value"

const worktreeCtx = (): TankContext => ({
  botId: BOT_ID,
  botName: "dev-demo",
  cwd: "/tank/dev-demo/work/step",
  home: "/tank/dev-demo/home",
  env: { HOME: "/tank/dev-demo/home", PATH: "/bin" },
  worktree: { path: "/tank/dev-demo/work/step", branch: BRANCH, repoDir: "/tank/dev-demo/repos/x" },
})

interface Seen {
  readonly argv: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
  readonly stepEnv: Readonly<Record<string, string>>
}

// The fake Tank, with every exec also recorded together with the context it ran in (env and stepEnv).
const recordingTank = (exec: (argv: ReadonlyArray<string>) => ExecResult = HEALTHY_EXEC) => {
  const fake = makeFakeTank({ exec })
  const seen: Array<Seen> = []
  const shape: TankShape = {
    ...fake.shape,
    exec: (ctx, argv, opts) => {
      seen.push({ argv, env: ctx.env, stepEnv: ctx.stepEnv ?? {} })
      return fake.shape.exec(ctx, argv, opts)
    },
  }
  return { shape, seen }
}

const installation = { id: 42, token: Redacted.make(TOKEN) }
const input = { taskId: TASK_ID, title: "Add sum", base: "main", issue: 1, installation }

describe("deliverCode as a GitHub App installation", () => {
  it.effect("pushes with the token in the env of the push only, and opens the PR as the installation", () => {
    const tank = recordingTank()
    const gh = GhClientTest()
    return Effect.gen(function* () {
      const artifact = yield* deliverCode(tank.shape, worktreeCtx(), input, gh.shape)
      expect(artifact).toEqual({ kind: "pr", ref: "https://github.com/renzer83/shoalwork-sandbox/pull/1" })

      const push = tank.seen.find((call) => call.argv.includes("push"))
      expect(push?.argv).toEqual([
        "git",
        "-c",
        "credential.helper=",
        "-c",
        'credential.helper=!f() { echo username=x-access-token; echo "password=$SHOALWORK_GIT_TOKEN"; }; f',
        "push",
        "-u",
        "origin",
        BRANCH,
      ])
      expect(push?.env.SHOALWORK_GIT_TOKEN).toBe(TOKEN)
      expect(push?.stepEnv.SHOALWORK_GIT_TOKEN).toBe(TOKEN)

      expect(gh.calls).toEqual([
        {
          method: "prCreate",
          args: [
            "/tank/dev-demo/work/step",
            { title: "Add sum", body: "Closes #1", base: "main" },
            { installationId: 42 },
          ],
        },
      ])
    })
  })

  it.effect("the token appears in no argv, no evidence and no failure message", () => {
    const tank = recordingTank((argv) =>
      argv.includes("push")
        ? {
            exitCode: 128,
            stdout: "",
            stderr: "fatal: could not read Username",
            durationMs: 1,
            timedOut: false,
          }
        : HEALTHY_EXEC(argv),
    )
    return Effect.gen(function* () {
      const failure = yield* Effect.flip(deliverCode(tank.shape, worktreeCtx(), input, GhClientTest().shape))
      expect(failure.message).toBe("git push exited 128: fatal: could not read Username")
      expect(JSON.stringify(tank.seen.map((call) => call.argv))).not.toContain(TOKEN)
      expect(failure.message).not.toContain(TOKEN)
    })
  })

  it.effect("without an installation the push is the Bot's own, unchanged, and gh gets no auth", () => {
    const tank = recordingTank()
    const gh = GhClientTest()
    return Effect.gen(function* () {
      yield* deliverCode(tank.shape, worktreeCtx(), { ...input, installation: undefined }, gh.shape)
      const push = tank.seen.find((call) => call.argv.includes("push"))
      expect(push?.argv).toEqual(["git", "push", "-u", "origin", BRANCH])
      expect(push?.env).not.toHaveProperty("SHOALWORK_GIT_TOKEN")
      expect(gh.calls[0]?.args).toHaveLength(2)
    })
  })
})
