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
// reads process.env itself. `timeoutMs` bounds each CLI call (default DEFAULT_PROBE_TIMEOUT_MS).
export type DoctorConfigShape = {
  readonly pinned: ExecutorVersions
  readonly env: Readonly<Record<string, string>>
  readonly timeoutMs?: number
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
  timeoutMs?: number,
): Layer.Layer<DoctorConfig, ConfigError> =>
  Layer.effect(
    DoctorConfig,
    loadExecutorVersions(path).pipe(
      Effect.map((pinned) => (timeoutMs === undefined ? { pinned, env } : { pinned, env, timeoutMs })),
    ),
  )

// Upper bound for each CLI call the doctor makes. A real CLI can take over 10 s on a loaded host (gemini --version
// measured at ~12 s), so the default is generous; a caller that wants a tighter bound passes timeoutMs.
export const DEFAULT_PROBE_TIMEOUT_MS = 30_000

// How many CLIs are probed at once. The probes are independent, so the boot waits for the slowest, not the sum.
export const PROBE_CONCURRENCY = 4

type Env = Readonly<Record<string, string>>
// What a probe needs: the allowlisted env and the bound of each CLI call.
type Probe = { readonly env: Env; readonly timeoutMs: number }
type CliRun = { readonly exitCode: number; readonly stdout: string; readonly timedOut: boolean }

// argv only, never a shell. null: the binary could not be spawned (not on PATH, not executable).
const runCli = (probe: Probe, bin: string, args: ReadonlyArray<string>): Effect.Effect<CliRun | null> =>
  runProcess([bin, ...args], {
    cwd: probe.env.HOME ?? tmpdir(),
    env: probe.env,
    timeoutMs: probe.timeoutMs,
  }).pipe(
    Effect.map(({ exitCode, stdout, timedOut }): CliRun => ({ exitCode, stdout, timedOut })),
    Effect.catchTag("TankError", () => Effect.succeed(null)),
  )

export const parseSemver = (text: string): string | null => text.match(/\d+\.\d+\.\d+/)?.[0] ?? null

type VersionRead =
  | { readonly ok: true; readonly installed: string }
  | { readonly ok: false; readonly detail: string }

const readVersion = (probe: Probe, bin: string): Effect.Effect<VersionRead> =>
  runCli(probe, bin, ["--version"]).pipe(
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
type AuthProblem = (probe: Probe, bin: string) => Effect.Effect<string | null>

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

const claudeAuth: AuthProblem = (probe, bin) =>
  runCli(probe, bin, ["auth", "status"]).pipe(
    Effect.map((run) => {
      if (run === null || run.timedOut || run.exitCode !== 0) return "claude auth status failed"
      const method = authMethodOf(run.stdout)
      if (method === null) return "claude auth status printed no authMethod"
      return method === "none" ? "not logged in (authMethod none)" : null
    }),
  )

const codexAuth: AuthProblem = (probe, bin) =>
  runCli(probe, bin, ["login", "status"]).pipe(
    Effect.map((run) =>
      run !== null && !run.timedOut && run.exitCode === 0 ? null : "codex login status failed",
    ),
  )

const geminiAuth: AuthProblem = (probe) =>
  Effect.sync(() => {
    const env = probe.env
    if ((env.GEMINI_API_KEY ?? "") !== "") return null
    const home = env.GEMINI_CLI_HOME ?? env.HOME
    if (home === undefined) return "neither GEMINI_CLI_HOME nor HOME is set"
    return existsSync(join(home, ".gemini", "oauth_creds.json"))
      ? null
      : "no GEMINI_API_KEY and no .gemini/oauth_creds.json"
  })

const opencodeAuth: AuthProblem = (probe) =>
  Effect.sync(() => {
    const env = probe.env
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
const checkCli = (pinnedAll: ExecutorVersions, probe: Probe, entry: CliEntry): Effect.Effect<DoctorReport> =>
  Effect.gen(function* () {
    const pinned = pinnedAll[entry.pin]
    const version = yield* readVersion(probe, entry.bin)
    if (!version.ok) return report(entry, pinned, null, "missing", version.detail)
    const installed = version.installed
    const authProblem = yield* entry.authProblem(probe, entry.bin)
    const drift = installed === pinned ? null : `installed ${installed}, pinned ${pinned}`
    if (authProblem !== null) {
      return report(entry, pinned, installed, "auth_missing", joinDetail(authProblem, drift))
    }
    if (drift !== null) return report(entry, pinned, installed, "drift", drift)
    return report(entry, pinned, installed, "ok", undefined)
  })

// Never fails: every problem with a CLI becomes its report. Running it is the core's job; this only describes. The CLIs
// are probed PROBE_CONCURRENCY at a time, and the reports keep the order of CLI_EXECUTORS.
export const doctor = (): Effect.Effect<ReadonlyArray<DoctorReport>, never, DoctorConfig> =>
  Effect.gen(function* () {
    const cfg = yield* DoctorConfig
    const probe: Probe = { env: cfg.env, timeoutMs: cfg.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS }
    return yield* Effect.forEach(CLI_EXECUTORS, (entry) => checkCli(cfg.pinned, probe, entry), {
      concurrency: PROBE_CONCURRENCY,
    })
  })
