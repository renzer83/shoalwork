import { existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ConfigError, ExecutorId } from "@shoalwork/contracts"
import { runProcess } from "@shoalwork/tank"
import { Context, Effect, Layer, Schema } from "effect"
import { parse } from "yaml"

// CLI versions each executor is pinned to (config/executor-versions.yaml). Every key is required: a missing pin is a
// ConfigError at boot, not a report.
const Semver = Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/))
export const ExecutorVersions = Schema.Struct({
  "claude-code": Semver,
  codex: Semver,
  gemini: Semver,
  opencode: Semver,
})
export type ExecutorVersions = typeof ExecutorVersions.Type

export type DoctorStatus = "ok" | "drift" | "missing" | "auth_missing"

export type DoctorReport = {
  executor: ExecutorId
  bin: string
  installed: string | null
  pinned: string
  status: DoctorStatus
  detail?: string
}

// `pinned` comes from the yaml; `env` is the allowlisted environment chosen by the composition root. The doctor never
// reads process.env itself.
export type DoctorConfigShape = {
  readonly pinned: ExecutorVersions
  readonly env: Readonly<Record<string, string>>
}

export class DoctorConfig extends Context.Service<DoctorConfig, DoctorConfigShape>()(
  "@shoalwork/DoctorConfig",
) {}

const describeCause = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

// Reads and validates config/executor-versions.yaml. Missing file, YAML syntax error and shape error are ConfigError.
export const loadExecutorVersions = (path: string): Effect.Effect<ExecutorVersions, ConfigError> =>
  Effect.gen(function* () {
    const text = yield* Effect.try({
      try: () => readFileSync(path, "utf8"),
      catch: (cause) =>
        new ConfigError({ key: path, message: `cannot read executor versions: ${describeCause(cause)}` }),
    })
    const raw = yield* Effect.try({
      try: (): unknown => parse(text),
      catch: (cause) => new ConfigError({ key: path, message: `invalid YAML: ${describeCause(cause)}` }),
    })
    return yield* Schema.decodeUnknownEffect(ExecutorVersions)(raw).pipe(
      Effect.mapError((error) => new ConfigError({ key: path, message: error.message })),
    )
  })

export const DoctorConfigLive = (
  path: string,
  env: Readonly<Record<string, string>>,
): Layer.Layer<DoctorConfig, ConfigError> =>
  Layer.effect(DoctorConfig, loadExecutorVersions(path).pipe(Effect.map((pinned) => ({ pinned, env }))))

// Upper bound for every CLI call the doctor makes. Real CLIs answer --version in well under a second.
const PROBE_TIMEOUT_MS = 10_000

type Env = Readonly<Record<string, string>>
type CliRun = { readonly exitCode: number; readonly stdout: string; readonly timedOut: boolean }

// argv only, never a shell. null: the binary could not be spawned (not on PATH, not executable).
const runCli = (env: Env, bin: string, args: ReadonlyArray<string>): Effect.Effect<CliRun | null> =>
  runProcess([bin, ...args], { cwd: env.HOME ?? tmpdir(), env, timeoutMs: PROBE_TIMEOUT_MS }).pipe(
    Effect.map(({ exitCode, stdout, timedOut }): CliRun => ({ exitCode, stdout, timedOut })),
    Effect.catchTag("TankError", () => Effect.succeed(null)),
  )

export const parseSemver = (text: string): string | null => text.match(/\d+\.\d+\.\d+/)?.[0] ?? null

type VersionRead =
  | { readonly ok: true; readonly installed: string }
  | { readonly ok: false; readonly detail: string }

const readVersion = (env: Env, bin: string): Effect.Effect<VersionRead> =>
  runCli(env, bin, ["--version"]).pipe(
    Effect.map((run): VersionRead => {
      if (run === null) return { ok: false, detail: `cannot run ${bin}` }
      if (run.timedOut) return { ok: false, detail: `${bin} --version timed out` }
      if (run.exitCode !== 0) return { ok: false, detail: `${bin} --version exited ${run.exitCode}` }
      const installed = parseSemver(run.stdout)
      return installed === null
        ? { ok: false, detail: `no version number in ${bin} --version output` }
        : { ok: true, installed }
    }),
  )

// Each authProblem returns null when the CLI is logged in, otherwise a short reason (never the CLI's output).
type AuthProblem = (env: Env, bin: string) => Effect.Effect<string | null>

const AuthStatus = Schema.Struct({ authMethod: Schema.String })

// Not JSON (or no authMethod) yields null, which the caller reports as a failed status check.
const authMethodOf = (stdout: string): string | null => {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    return null
  }
  return Schema.is(AuthStatus)(value) ? value.authMethod : null
}

const claudeAuth: AuthProblem = (env, bin) =>
  runCli(env, bin, ["auth", "status"]).pipe(
    Effect.map((run) => {
      if (run === null || run.timedOut || run.exitCode !== 0) return "claude auth status failed"
      const method = authMethodOf(run.stdout)
      if (method === null) return "claude auth status printed no authMethod"
      return method === "none" ? "not logged in (authMethod none)" : null
    }),
  )

const codexAuth: AuthProblem = (env, bin) =>
  runCli(env, bin, ["login", "status"]).pipe(
    Effect.map((run) =>
      run !== null && !run.timedOut && run.exitCode === 0 ? null : "codex login status failed",
    ),
  )

const geminiAuth: AuthProblem = (env) =>
  Effect.sync(() => {
    if ((env.GEMINI_API_KEY ?? "") !== "") return null
    const home = env.GEMINI_CLI_HOME ?? env.HOME
    if (home === undefined) return "neither GEMINI_CLI_HOME nor HOME is set"
    return existsSync(join(home, ".gemini", "oauth_creds.json"))
      ? null
      : "no GEMINI_API_KEY and no .gemini/oauth_creds.json"
  })

const opencodeAuth: AuthProblem = (env) =>
  Effect.sync(() => {
    const dataHome =
      env.XDG_DATA_HOME ?? (env.HOME === undefined ? undefined : join(env.HOME, ".local", "share"))
    if (dataHome === undefined) return "neither XDG_DATA_HOME nor HOME is set"
    return existsSync(join(dataHome, "opencode", "auth.json")) ? null : "no opencode/auth.json"
  })

const decodeId = (value: string): ExecutorId => Schema.decodeUnknownSync(ExecutorId)(value)

type CliEntry = {
  readonly executor: ExecutorId
  readonly bin: string
  readonly pin: keyof ExecutorVersions
  readonly authProblem: AuthProblem
}

const CLI_EXECUTORS: ReadonlyArray<CliEntry> = [
  { executor: decodeId("claude-code"), bin: "claude", pin: "claude-code", authProblem: claudeAuth },
  { executor: decodeId("codex"), bin: "codex", pin: "codex", authProblem: codexAuth },
  { executor: decodeId("gemini"), bin: "gemini", pin: "gemini", authProblem: geminiAuth },
  { executor: decodeId("opencode"), bin: "opencode", pin: "opencode", authProblem: opencodeAuth },
]

const joinDetail = (...parts: ReadonlyArray<string | null>): string | undefined => {
  const present = parts.filter((part): part is string => part !== null)
  return present.length === 0 ? undefined : present.join("; ")
}

const report = (
  entry: CliEntry,
  pinned: string,
  installed: string | null,
  status: DoctorStatus,
  detail: string | undefined,
): DoctorReport => ({
  executor: entry.executor,
  bin: entry.bin,
  installed,
  pinned,
  status,
  ...(detail === undefined ? {} : { detail }),
})

// Precedence: missing > auth_missing > drift > ok. A drifted version with no login is reported as auth_missing, with
// the drift kept in detail.
const checkCli = (cfg: DoctorConfigShape, entry: CliEntry): Effect.Effect<DoctorReport> =>
  Effect.gen(function* () {
    const pinned = cfg.pinned[entry.pin]
    const version = yield* readVersion(cfg.env, entry.bin)
    if (!version.ok) return report(entry, pinned, null, "missing", version.detail)
    const installed = version.installed
    const authProblem = yield* entry.authProblem(cfg.env, entry.bin)
    const drift = installed === pinned ? null : `installed ${installed}, pinned ${pinned}`
    if (authProblem !== null) {
      return report(entry, pinned, installed, "auth_missing", joinDetail(authProblem, drift))
    }
    if (drift !== null) return report(entry, pinned, installed, "drift", drift)
    return report(entry, pinned, installed, "ok", undefined)
  })

// Never fails: every problem with a CLI becomes its report. Running it is the core's job; this only describes.
export const doctor = (): Effect.Effect<ReadonlyArray<DoctorReport>, never, DoctorConfig> =>
  Effect.gen(function* () {
    const cfg = yield* DoctorConfig
    const reports: Array<DoctorReport> = []
    for (const entry of CLI_EXECUTORS) {
      reports.push(yield* checkCli(cfg, entry))
    }
    return reports
  })
