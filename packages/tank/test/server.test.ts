import { it } from "@effect/vitest"
import { TankError } from "@shoalwork/contracts"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { buildBotEnv } from "../src/local.js"
import { TankServerLive } from "../src/server.js"
import { NOPASSWD_HINT, planLaunch, sudoArgv, sudoRefusal } from "../src/sudo.js"
import { Tank, type TankContext } from "../src/tank.js"
import { makeBot, stepId } from "./helpers.js"

// No real sudo here: these tests check the argv and the refusal mapping, and the preflight of a missing user.
const spawnEnv = { PATH: "/usr/bin:/bin" }
const botHome = "/home/bot-alice"

describe("sudoArgv", () => {
  it("wraps the command as the Bot user with cwd and env re-applied by env(1)", () => {
    const argv = Effect.runSync(
      sudoArgv({
        user: "bot-alice",
        cwd: `${botHome}/work/s1`,
        env: { HOME: botHome, PATH: "/usr/bin:/bin" },
        cmd: ["git", "status"],
      }),
    )
    expect(argv).toEqual([
      "sudo",
      "-n",
      "-u",
      "bot-alice",
      "-H",
      "--",
      "env",
      "-C",
      `${botHome}/work/s1`,
      `HOME=${botHome}`,
      "PATH=/usr/bin:/bin",
      "git",
      "status",
    ])
  })

  it("adds no env wrapper when neither cwd nor env is given", () => {
    const argv = Effect.runSync(sudoArgv({ user: "bot-alice", cmd: ["test", "-e", `${botHome}/x`] }))
    expect(argv).toEqual(["sudo", "-n", "-u", "bot-alice", "-H", "--", "test", "-e", `${botHome}/x`])
  })

  it("keeps every argument as one argv entry, never through a shell", () => {
    const argv = Effect.runSync(sudoArgv({ user: "bot-alice", cmd: ["sh", "-c", "echo $HOME; rm -rf /"] }))
    expect(argv.slice(-3)).toEqual(["sh", "-c", "echo $HOME; rm -rf /"])
  })

  it("rejects an empty command and env names that env(1) would misread", () => {
    const empty = Effect.runSync(Effect.flip(sudoArgv({ user: "bot-alice", cmd: [] })))
    expect(empty).toBeInstanceOf(TankError)
    const badKey = Effect.runSync(
      Effect.flip(sudoArgv({ user: "bot-alice", cmd: ["true"], env: { "BAD-KEY": "x" } })),
    )
    expect(badKey).toBeInstanceOf(TankError)
  })
})

describe("planLaunch", () => {
  it("in sudo mode runs sudo from the neutral cwd with only PATH in the spawn env", () => {
    const plan = Effect.runSync(
      planLaunch(
        true,
        "bot-alice",
        { cmd: ["claude"], cwd: `${botHome}/work/s1`, env: { HOME: botHome } },
        spawnEnv,
      ),
    )
    expect(plan.argv.slice(0, 6)).toEqual(["sudo", "-n", "-u", "bot-alice", "-H", "--"])
    expect(plan.cwd).toBe("/")
    expect(plan.env).toEqual(spawnEnv)
  })

  it("fallback (sudo off) runs the command unchanged as the current user in the given cwd", () => {
    const plan = Effect.runSync(
      planLaunch(
        false,
        "bot-alice",
        { cmd: ["git", "fetch"], cwd: `${botHome}/repos/x`, env: { HOME: botHome } },
        spawnEnv,
      ),
    )
    expect(plan.argv).toEqual(["git", "fetch"])
    expect(plan.cwd).toBe(`${botHome}/repos/x`)
    expect(plan.env).toEqual({ HOME: botHome })
  })

  it("fallback without cwd or env uses the neutral cwd and the spawn env", () => {
    const plan = Effect.runSync(planLaunch(false, "bot-alice", { cmd: ["id", "-u"] }, spawnEnv))
    expect(plan).toEqual({ argv: ["id", "-u"], cwd: "/", env: spawnEnv })
  })
})

describe("credentials under sudo", () => {
  it("host credentials from the base env never reach the Bot's argv", () => {
    const baseEnv = {
      PATH: "/usr/bin:/bin",
      ANTHROPIC_API_KEY: "test-key-not-real",
      ANTHROPIC_AUTH_TOKEN: "test-auth-not-real",
      CLAUDE_CODE_OAUTH_TOKEN: "test-oauth-not-real",
    }
    const env = buildBotEnv(baseEnv, botHome)
    const argv = Effect.runSync(sudoArgv({ user: "bot-alice", cwd: botHome, env, cmd: ["claude"] }))
    const joined = argv.join("\n")
    expect(joined).not.toContain("ANTHROPIC")
    expect(joined).not.toContain("CLAUDE_CODE_OAUTH_TOKEN")
    expect(argv).toContain(`CLAUDE_CONFIG_DIR=${botHome}/.claude`)
    expect(argv).toContain(`HOME=${botHome}`)
  })
})

describe("sudoRefusal", () => {
  it("maps a password request to a TankError op sudo with the sudoers instruction", () => {
    const e = sudoRefusal(1, "sudo: a password is required\n")
    expect(e).toBeInstanceOf(TankError)
    expect(e).toMatchObject({ op: "sudo", cause: NOPASSWD_HINT })
  })

  it("maps a sudo refusal without echoing the refused command", () => {
    const e = sudoRefusal(
      1,
      "sudo: user renan is not allowed to execute '/usr/bin/env ANTHROPIC_API_KEY=x claude' as bot-alice\n",
    )
    expect(e).toBeInstanceOf(TankError)
    expect(e).toMatchObject({ op: "sudo" })
    expect(JSON.stringify(e)).not.toContain("ANTHROPIC_API_KEY")
  })

  it("ignores success and failures that sudo did not print", () => {
    expect(sudoRefusal(0, "sudo: a password is required")).toBeUndefined()
    expect(sudoRefusal(1, "password is required for the git credential helper")).toBeUndefined()
    expect(sudoRefusal(2, "fatal: not a git repository")).toBeUndefined()
  })
})

describe("TankServer", () => {
  it.live("is a server-mode Tank", () =>
    Effect.gen(function* () {
      const tank = yield* Tank
      expect(tank.mode).toBe("server")
    }).pipe(Effect.provide(TankServerLive({ baseEnv: { PATH: "/usr/bin:/bin" }, sudo: true }))),
  )

  it.live("prepare with a Bot whose Linux user does not exist fails with an instruction", () => {
    const name = `nosuch-${crypto.randomUUID().slice(0, 8)}`
    return Effect.gen(function* () {
      const tank = yield* Tank
      const e = yield* tank.prepare(makeBot(name), { stepId: stepId() }).pipe(Effect.flip)
      expect(e).toBeInstanceOf(TankError)
      expect(e).toMatchObject({
        op: "prepare",
        cause: expect.stringContaining(`scripts/tank-user-create.sh ${name} as root`),
      })
    }).pipe(Effect.provide(TankServerLive({ baseEnv: { PATH: process.env.PATH }, sudo: true })))
  })

  it.live("refuses a forged context whose bot name would pick another Linux user", () =>
    Effect.gen(function* () {
      const tank = yield* Tank
      const forged: TankContext = {
        botId: makeBot("alice").id,
        botName: "../root",
        cwd: "/",
        home: "/",
        env: {},
      }
      const e = yield* tank.exec(forged, ["true"]).pipe(Effect.flip)
      expect(e).toBeInstanceOf(TankError)
      expect(e).toMatchObject({ op: "prepare" })
    }).pipe(Effect.provide(TankServerLive({ baseEnv: { PATH: "/usr/bin:/bin" }, sudo: true }))),
  )
})
