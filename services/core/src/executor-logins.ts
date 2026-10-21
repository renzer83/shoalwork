import { join } from "node:path"
import { type Bot, BotId, StepId } from "@shoalwork/contracts"
import { Tank, type TankContext, type TankShape } from "@shoalwork/tank"
import { Effect, Result, Schema } from "effect"

// Whether a Bot's CLI is logged in. The secret never leaves the probe: only the CLI's own auth method name (validated
// below) and this state are kept.
export const LoginState = Schema.Literals(["logged_in", "logged_out", "unknown"])
export type LoginState = typeof LoginState.Type

export const LoginView = Schema.Struct({
  botId: BotId,
  authMethod: Schema.NullOr(Schema.String),
  state: LoginState,
})
export type LoginView = typeof LoginView.Type

export const LOGIN_BINS = ["claude", "codex", "gemini", "opencode"] as const
export type LoginBin = (typeof LOGIN_BINS)[number]

// The step whose work folder the probes run in. Fixed: a login check creates no new folder per call.
const LOGIN_STEP = Schema.decodeUnknownSync(StepId)("step_00000000-0000-4000-8000-00000000a117")
const LOGIN_TIMEOUT_MS = 10_000
const LOGIN_CONCURRENCY = 4
// A CLI's auth method is a short lowercase word (claude prints "claude.ai", "console", "none"). Anything else is dropped.
const METHOD_PATTERN = /^[a-z][a-z_.]{0,23}$/
const AuthStatus = Schema.Struct({ authMethod: Schema.String })

// Not JSON, no authMethod, or a method outside the pattern: null, which the caller reports as unknown.
export const authMethodOf = (stdout: string): string | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!Schema.is(AuthStatus)(parsed)) return null
  return METHOD_PATTERN.test(parsed.authMethod) ? parsed.authMethod : null
}

type Probed = { readonly authMethod: string | null; readonly state: LoginState }
const UNKNOWN: Probed = { authMethod: null, state: "unknown" }

// argv only (no shell). A spawn failure is unknown, never a crash of the overview.
const exec = (tank: TankShape, ctx: TankContext, argv: ReadonlyArray<string>) =>
  tank
    .exec(ctx, argv, { timeoutMs: LOGIN_TIMEOUT_MS })
    .pipe(Effect.catchTag("TankError", () => Effect.succeed(null)))

const claudeLogin = (tank: TankShape, ctx: TankContext): Effect.Effect<Probed> =>
  exec(tank, ctx, ["claude", "auth", "status"]).pipe(
    Effect.map((result): Probed => {
      if (result === null || result.timedOut || result.exitCode !== 0) return UNKNOWN
      const method = authMethodOf(result.stdout)
      if (method === null) return UNKNOWN
      return { authMethod: method, state: method === "none" ? "logged_out" : "logged_in" }
    }),
  )

const codexLogin = (tank: TankShape, ctx: TankContext): Effect.Effect<Probed> =>
  exec(tank, ctx, ["codex", "login", "status"]).pipe(
    Effect.map((result): Probed => {
      if (result === null || result.timedOut) return UNKNOWN
      return { authMethod: null, state: result.exitCode === 0 ? "logged_in" : "logged_out" }
    }),
  )

// The credentials file is checked by its existence (ls prints only the path). ls exits 1 or 2 for a missing file.
const fileLogin = (
  tank: TankShape,
  ctx: TankContext,
  path: string,
  authMethod: string | null,
): Effect.Effect<Probed> =>
  exec(tank, ctx, ["ls", "-1", path]).pipe(
    Effect.map((result): Probed => {
      if (result === null || result.timedOut) return UNKNOWN
      if (result.exitCode === 0) return { authMethod, state: "logged_in" }
      if (result.exitCode === 1 || result.exitCode === 2) return { authMethod: null, state: "logged_out" }
      return UNKNOWN
    }),
  )

// Mirrors the doctor's rules (packages/executors/src/doctor.ts): an API key in the Bot env counts as a login.
const geminiLogin = (tank: TankShape, ctx: TankContext): Effect.Effect<Probed> => {
  if ((ctx.env.GEMINI_API_KEY ?? "") !== "") {
    return Effect.succeed({ authMethod: "api_key", state: "logged_in" })
  }
  const home = ctx.env.GEMINI_CLI_HOME ?? ctx.home
  return fileLogin(tank, ctx, join(home, ".gemini", "oauth_creds.json"), "oauth")
}

const opencodeLogin = (tank: TankShape, ctx: TankContext): Effect.Effect<Probed> => {
  const dataHome = ctx.env.XDG_DATA_HOME ?? join(ctx.home, ".local", "share")
  return fileLogin(tank, ctx, join(dataHome, "opencode", "auth.json"), null)
}

const probeOf: Record<LoginBin, (tank: TankShape, ctx: TankContext) => Effect.Effect<Probed>> = {
  claude: claudeLogin,
  codex: codexLogin,
  gemini: geminiLogin,
  opencode: opencodeLogin,
}

export type BinLogin = { readonly bin: LoginBin; readonly login: LoginView }

// The Bot's HOME is where each CLI keeps its login, so every probe runs in the Bot's own Tank context.
const loginsOfBot = (tank: TankShape, bot: Bot): Effect.Effect<ReadonlyArray<BinLogin>> =>
  Effect.gen(function* () {
    const prepared = yield* Effect.result(tank.prepare(bot, { stepId: LOGIN_STEP }))
    return yield* Effect.forEach(LOGIN_BINS, (bin) => {
      const probe: Effect.Effect<Probed> = Result.isSuccess(prepared)
        ? probeOf[bin](tank, prepared.success)
        : Effect.succeed(UNKNOWN)
      return probe.pipe(
        Effect.map(
          (probed): BinLogin => ({
            bin,
            login: { botId: bot.id, authMethod: probed.authMethod, state: probed.state },
          }),
        ),
      )
    })
  })

// The login of every given Bot for every CLI that has one. Bots are probed LOGIN_CONCURRENCY at a time.
export const botLogins = (bots: ReadonlyArray<Bot>): Effect.Effect<ReadonlyArray<BinLogin>, never, Tank> =>
  Effect.gen(function* () {
    const tank = yield* Tank
    const perBot = yield* Effect.forEach(bots, (bot) => loginsOfBot(tank, bot), {
      concurrency: LOGIN_CONCURRENCY,
    })
    return perBot.flat()
  })
