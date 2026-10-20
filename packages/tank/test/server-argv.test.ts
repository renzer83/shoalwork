import { TankError } from "@shoalwork/contracts"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { makeTankServer, type RunFn } from "../src/server.js"
import { sudoArgv } from "../src/sudo.js"
import type { TankContext } from "../src/tank.js"
import { makeBot } from "./helpers.js"

// Fake sudo: records every command the server Tank would run, answers realpath from `realpathOf`, exits 0 otherwise.
type Call = {
  readonly argv: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
  readonly stdin: string | undefined
}

const fakeRun = (realpathOf: (path: string) => string = (path) => path) => {
  const calls: Array<Call> = []
  const run: RunFn = (cmd, opts) =>
    Effect.sync(() => {
      calls.push({ argv: cmd, env: { ...opts.env }, stdin: opts.stdin })
      const stdout = cmd.includes("realpath") ? `${realpathOf(cmd[cmd.length - 1] ?? "")}\n` : ""
      return { exitCode: 0, stdout, stderr: "", durationMs: 0, timedOut: false }
    })
  return { calls, run }
}

const SECRET = "mcp_SECRET-VALUE-not-real"
const home = "/home/bot-alice"
const bot = makeBot("alice")
const ctx: TankContext = {
  botId: bot.id,
  botName: "alice",
  cwd: `${home}/work/s1`,
  home,
  env: { HOME: home, PATH: "/usr/bin:/bin", SHOALWORK_API_TOKEN: SECRET },
  stepEnv: { SHOALWORK_API_TOKEN: SECRET },
}
const baseEnv = { PATH: "/usr/bin:/bin" }

const serverTank = (run: RunFn) => makeTankServer({ baseEnv, sudo: true, run })

const sudoCalls = (calls: ReadonlyArray<Call>) => calls.filter((call) => call.argv[0] === "sudo")

describe("server writeHomeFile argv", () => {
  it("creates the file with install -m as the Bot user, content on stdin, no shell", async () => {
    const fake = fakeRun()
    await Effect.runPromise(
      serverTank(fake.run).writeHomeFile(ctx, ".codex/config.toml", "model = 'x'\n", 0o600),
    )
    const install = sudoCalls(fake.calls).find((call) => call.argv.includes("install"))
    expect(install).toBeDefined()
    expect(install?.argv).toEqual([
      "sudo",
      "-n",
      "-u",
      "bot-alice",
      "-H",
      "--",
      "install",
      "-m",
      "600",
      "--",
      "/dev/stdin",
      `${home}/.codex/config.toml`,
    ])
    expect(install?.stdin).toBe("model = 'x'\n")
    expect(fake.calls.some((call) => call.argv.includes("tee"))).toBe(false)
    expect(fake.calls.some((call) => ["sh", "bash", "/bin/sh"].includes(call.argv[0] ?? ""))).toBe(false)
  })

  it("passes the mode as octal digits", async () => {
    const fake = fakeRun()
    await Effect.runPromise(serverTank(fake.run).writeHomeFile(ctx, "a.txt", "x", 0o640))
    const install = sudoCalls(fake.calls).find((call) => call.argv.includes("install"))
    expect(install?.argv).toContain("640")
  })

  it("refuses a mode outside 0..0o777 before any command runs", async () => {
    const fake = fakeRun()
    const error = await Effect.runPromise(
      Effect.flip(serverTank(fake.run).writeHomeFile(ctx, "a.txt", "x", 0o1000)),
    )
    expect(error).toBeInstanceOf(TankError)
    expect(fake.calls).toHaveLength(0)
  })

  it("refuses a home whose realpath leaves the Bot directory (fail closed), with no write", async () => {
    const fake = fakeRun((path) => (path === home ? "/srv/elsewhere" : path))
    const error = await Effect.runPromise(
      Effect.flip(serverTank(fake.run).writeHomeFile(ctx, "a.txt", "x", 0o600)),
    )
    expect(error).toBeInstanceOf(TankError)
    expect(fake.calls.some((call) => call.argv.includes("install"))).toBe(false)
  })
})

describe("server exec argv and the execution's secret", () => {
  it("keeps the step's token out of argv and hands its name to sudo --preserve-env", async () => {
    const fake = fakeRun()
    await Effect.runPromise(serverTank(fake.run).exec(ctx, ["git", "status"]))
    const call = sudoCalls(fake.calls).find((entry) => entry.argv.includes("git"))
    expect(call).toBeDefined()
    expect(call?.argv.join(" ")).not.toContain(SECRET)
    expect(call?.argv).toContain("--preserve-env=SHOALWORK_API_TOKEN")
    expect(call?.argv.join(" ")).not.toContain("SHOALWORK_API_TOKEN=")
    expect(call?.env.SHOALWORK_API_TOKEN).toBe(SECRET)
    expect(call?.argv).toContain(`HOME=${home}`)
  })

  it("lists in --preserve-env only the step's keys, never the base env", async () => {
    const fake = fakeRun()
    const plain = { ...ctx, env: { ...ctx.env, HOME: home }, stepEnv: { SHOALWORK_A: "1" } }
    await Effect.runPromise(serverTank(fake.run).exec(plain, ["true"]))
    const call = sudoCalls(fake.calls)[0]
    expect(call?.argv).toContain("--preserve-env=SHOALWORK_A")
    expect(call?.argv.some((arg) => arg.startsWith("--preserve-env=") && arg.includes("HOME"))).toBe(false)
  })

  it("adds no --preserve-env when the execution has no env of its own", async () => {
    const fake = fakeRun()
    await Effect.runPromise(serverTank(fake.run).exec({ ...ctx, stepEnv: {} }, ["true"]))
    expect(sudoCalls(fake.calls)[0]?.argv.some((arg) => arg.startsWith("--preserve-env"))).toBe(false)
  })
})

describe("sudoArgv preserve list", () => {
  it("refuses a preserved name that is not an env name", async () => {
    const error = await Effect.runPromise(
      Effect.flip(sudoArgv({ user: "bot-alice", cmd: ["true"], preserveEnv: ["BAD-NAME"] })),
    )
    expect(error).toBeInstanceOf(TankError)
  })
})
