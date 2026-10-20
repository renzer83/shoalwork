import { TankError } from "@shoalwork/contracts"
import { Effect } from "effect"

// Linux user that runs a Bot's commands in server mode (ADR-004). Created by scripts/tank-user-create.sh.
export const botUserName = (botName: string): string => `bot-${botName}`

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export type SudoRequest = {
  readonly user: string
  readonly cmd: ReadonlyArray<string>
  readonly cwd?: string | undefined
  readonly env?: Readonly<Record<string, string>> | undefined
  // Names only: sudo keeps these from its own environment (never from argv). ADR-004 "Env de step".
  readonly preserveEnv?: ReadonlyArray<string> | undefined
}

// `sudo` resets the environment (env_reset), so the Bot's cwd and env are re-applied by `env` after the switch.
// Every element is one argv entry: nothing is passed through a shell.
export const sudoArgv = (req: SudoRequest): Effect.Effect<ReadonlyArray<string>, TankError> =>
  Effect.gen(function* () {
    if (req.cmd.length === 0) return yield* Effect.fail(new TankError({ op: "sudo", cause: "empty command" }))
    const assignments: Array<string> = []
    for (const [key, value] of Object.entries(req.env ?? {})) {
      if (!ENV_NAME.test(key)) {
        return yield* Effect.fail(
          new TankError({ op: "sudo", cause: `invalid env name: ${JSON.stringify(key)}` }),
        )
      }
      assignments.push(`${key}=${value}`)
    }
    const preserve = req.preserveEnv ?? []
    for (const key of preserve) {
      if (!ENV_NAME.test(key)) {
        return yield* Effect.fail(
          new TankError({ op: "sudo", cause: `invalid preserved env name: ${JSON.stringify(key)}` }),
        )
      }
    }
    const wrapped =
      req.cwd === undefined && req.env === undefined
        ? [...req.cmd]
        : ["env", ...(req.cwd === undefined ? [] : ["-C", req.cwd]), ...assignments, ...req.cmd]
    const preserveFlag = preserve.length === 0 ? [] : [`--preserve-env=${preserve.join(",")}`]
    return ["sudo", "-n", ...preserveFlag, "-u", req.user, "-H", "--", ...wrapped]
  })

export type LaunchPlan = {
  readonly argv: ReadonlyArray<string>
  // Working directory of the spawned process itself. In sudo mode the Bot's cwd is applied by `env -C` instead,
  // because the core user may not be able to enter the Bot's home.
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
}

const withoutKeys = (
  env: Readonly<Record<string, string>>,
  keys: ReadonlyArray<string>,
): Record<string, string> => {
  const kept: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (!keys.includes(key)) kept[key] = value
  }
  return kept
}

// sudo=true: argv goes through sudo as the Bot's user. sudo=false (fallback): argv runs as the current user.
// `spawnEnv` only needs PATH: it locates `sudo` itself; the Bot env is passed through `env`.
// `passEnv` values (an execution's secrets) never enter argv: they go into the env of the sudo process, and their
// names into --preserve-env. The same keys are removed from the `env K=V` wrapper.
export const planLaunch = (
  sudo: boolean,
  user: string,
  req: {
    readonly cmd: ReadonlyArray<string>
    readonly cwd?: string | undefined
    readonly env?: Readonly<Record<string, string>> | undefined
    readonly passEnv?: Readonly<Record<string, string>> | undefined
  },
  spawnEnv: Readonly<Record<string, string>>,
): Effect.Effect<LaunchPlan, TankError> => {
  const passEnv = req.passEnv ?? {}
  const passKeys = Object.keys(passEnv)
  if (!sudo) {
    return Effect.succeed({
      argv: req.cmd,
      cwd: req.cwd ?? "/",
      env: { ...(req.env ?? spawnEnv), ...passEnv },
    })
  }
  const argvEnv = req.env === undefined ? undefined : withoutKeys(req.env, passKeys)
  return sudoArgv({ user, cmd: req.cmd, cwd: req.cwd, env: argvEnv, preserveEnv: passKeys }).pipe(
    Effect.map((argv) => ({ argv, cwd: "/", env: { ...spawnEnv, ...passEnv } })),
  )
}

export const NOPASSWD_HINT =
  "NOPASSWD required: sudoers must let the core user run as bot-* without a password (ADR-004, sudoers section)"

// Refusals printed by sudo itself (no tty, password asked, not allowed). Only sudo's own prefix is matched, so
// output of the Bot's command never counts. The sudo message is not forwarded: it can echo the env of the Bot.
const SUDO_REFUSAL =
  /^sudo: (a password is required|a terminal is required|no tty present|.*not allowed to execute|.*not allowed to preserve|.*unknown user|.*not in the sudoers file)/m
const SUDO_PASSWORD = /^sudo: (a password is required|a terminal is required|no tty present)/m

export const sudoRefusal = (exitCode: number, stderr: string): TankError | undefined => {
  if (exitCode === 0 || !SUDO_REFUSAL.test(stderr)) return undefined
  if (SUDO_PASSWORD.test(stderr)) return new TankError({ op: "sudo", cause: NOPASSWD_HINT })
  return new TankError({
    op: "sudo",
    cause:
      "sudo refused to run as the Bot user (check sudoers, the user name and the env_keep rule of ADR-004)",
  })
}
