import { dirname, join } from "node:path"
import { TankError } from "@shoalwork/contracts"
import { Effect, Layer } from "effect"
import { type BaseEnv, makeBotTank } from "./local.js"
import type { BotOps } from "./ops.js"
import { type ProcessOptions, runProcess, spawnProcess } from "./process.js"
import { botUserName, planLaunch, sudoRefusal } from "./sudo.js"
import { type ExecResult, Tank, type TankShape } from "./tank.js"

// Bot homes sit directly under /home (ADR-004): /home/bot-<name>. TANK_ROOT does not apply in server mode.
export const BOT_HOMES_ROOT = "/home"

const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin"

export type TankServerConfig = {
  readonly baseEnv: BaseEnv
  // true: commands run as bot-<name> through sudo. false (fallback): commands run as the current user.
  readonly sudo: boolean
  // Same meaning as TankLocalConfig.extraEnv; reaches the Bot only through the `env K=V` argv.
  readonly extraEnv?: Readonly<Record<string, string>>
}

type Call = {
  readonly cwd?: string | undefined
  readonly env?: Readonly<Record<string, string>> | undefined
  readonly timeoutMs?: number | undefined
  readonly stdin?: string | undefined
}

const checkExit = (op: string, r: ExecResult): Effect.Effect<void, TankError> =>
  r.exitCode === 0
    ? Effect.void
    : Effect.fail(
        new TankError({ op, cause: r.stderr.trim() === "" ? `exit ${r.exitCode}` : r.stderr.trim() }),
      )

// Operations for one Bot's Linux user. Each one is a plain argv (no shell) wrapped by planLaunch.
const botOps = (user: string, sudo: boolean, spawnEnv: Readonly<Record<string, string>>): BotOps => {
  const runIn = (cmd: ReadonlyArray<string>, call: Call): Effect.Effect<ExecResult, TankError> =>
    Effect.gen(function* () {
      const plan = yield* planLaunch(sudo, user, { cmd, cwd: call.cwd, env: call.env }, spawnEnv)
      const r = yield* runProcess(plan.argv, {
        cwd: plan.cwd,
        env: plan.env,
        ...(call.timeoutMs === undefined ? {} : { timeoutMs: call.timeoutMs }),
        ...(call.stdin === undefined ? {} : { stdin: call.stdin }),
      })
      const refused = sudo ? sudoRefusal(r.exitCode, r.stderr) : undefined
      if (refused !== undefined) return yield* Effect.fail(refused)
      return r
    })

  const ops: BotOps = {
    run: (cmd, opts) => runIn(cmd, opts),
    spawn: (cmd: ReadonlyArray<string>, opts: ProcessOptions) =>
      planLaunch(sudo, user, { cmd, cwd: opts.cwd, env: opts.env }, spawnEnv).pipe(
        Effect.flatMap((plan) => spawnProcess(plan.argv, { cwd: plan.cwd, env: plan.env })),
      ),
    exists: (path) =>
      runIn(["test", "-e", path], {}).pipe(
        Effect.flatMap((r) => {
          if (r.exitCode === 0) return Effect.succeed(true)
          if (r.exitCode === 1) return Effect.succeed(false)
          return Effect.fail(new TankError({ op: "stat", cause: r.stderr.trim() }))
        }),
      ),
    mkdirp: (path) =>
      runIn(["mkdir", "-p", "--", path], {}).pipe(Effect.flatMap((r) => checkExit("mkdir", r))),
    removeTree: (path) =>
      runIn(["rm", "-rf", "--", path], {}).pipe(Effect.flatMap((r) => checkExit("rm", r))),
    readText: (path) =>
      runIn(["cat", "--", path], {}).pipe(
        Effect.flatMap((r) => checkExit("readFile", r).pipe(Effect.as(r.stdout))),
      ),
    writeText: (path, content) =>
      ops.mkdirp(dirname(path)).pipe(
        Effect.flatMap(() => runIn(["tee", "--", path], { stdin: content })),
        Effect.flatMap((r) => checkExit("writeFile", r)),
      ),
  }
  return ops
}

// The Bot's Linux user must exist before anything is created for it. Runs as the current user (no sudo).
const preflightUser = (
  botName: string,
  spawnEnv: Readonly<Record<string, string>>,
): Effect.Effect<void, TankError> => {
  const user = botUserName(botName)
  return runProcess(["id", "-u", user], { cwd: "/", env: spawnEnv }).pipe(
    Effect.flatMap((r) =>
      r.exitCode === 0
        ? Effect.void
        : Effect.fail(
            new TankError({
              op: "prepare",
              cause: `Linux user ${user} does not exist: run scripts/tank-user-create.sh ${botName} as root`,
            }),
          ),
    ),
  )
}

export const makeTankServer = (config: TankServerConfig): TankShape => {
  const spawnEnv: Record<string, string> = { PATH: config.baseEnv.PATH ?? DEFAULT_PATH }
  return makeBotTank(
    {
      mode: "server",
      root: BOT_HOMES_ROOT,
      botDir: (botName) => join(BOT_HOMES_ROOT, botUserName(botName)),
      home: (botDir) => botDir,
      opsFor: (botName) => botOps(botUserName(botName), config.sudo, spawnEnv),
      preflight: (botName) => (config.sudo ? preflightUser(botName, spawnEnv) : Effect.void),
    },
    config.baseEnv,
    config.extraEnv,
  )
}

export const TankServerLive = (config: TankServerConfig): Layer.Layer<Tank> =>
  Layer.succeed(Tank, makeTankServer(config))
