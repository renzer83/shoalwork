import { ExecutorId, type SchemaViolation } from "@shoalwork/contracts"
import { Console, Effect, Schema } from "effect"
import { parseArgs, resolveSettings, type Settings, UsageError } from "../args.js"
import { ApiClient, type HttpError } from "../client.js"
import { quotaList, renderQuota } from "./executor.js"

// Mirrors the body of GET /executors/doctor (services/core/src/http/routes/executors.ts).
const DoctorReportView = Schema.Struct({
  executor: ExecutorId,
  bin: Schema.String,
  installed: Schema.NullOr(Schema.String),
  pinned: Schema.String,
  status: Schema.Literals(["ok", "drift", "missing", "auth_missing"]),
  detail: Schema.optionalKey(Schema.String),
})
export type DoctorView = typeof DoctorReportView.Type
export const DoctorBody = Schema.Struct({ reports: Schema.Array(DoctorReportView) })

// The CLIs whose fixtures `executors record` writes (packages/executors/test/fixtures/<executor>/<version>/).
const RECORDABLE = ["claude-code", "codex", "gemini", "opencode"] as const
const Recordable = Schema.Literals(RECORDABLE)
type Recordable = typeof Recordable.Type
const BIN_OF: Readonly<Record<Recordable, string>> = {
  "claude-code": "claude",
  codex: "codex",
  gemini: "gemini",
  opencode: "opencode",
}
const Semver = Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/))

// The three prompts every recording runs (T-081).
const PROMPTS: ReadonlyArray<string> = ["pong", "run `echo hi`", "create file x.txt"]

const SETTINGS_FLAGS = ["url", "token"]
const DOCTOR_USAGE = "usage: executors doctor [--strict]"
const LIST_USAGE = "usage: executors list"
const RECORD_USAGE = "usage: executors record --executor <id> --version <semver> --dry-run"

// Left-aligned columns, two spaces apart, trailing spaces trimmed. Shared by the doctor and the list tables.
const renderTable = (
  header: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
): ReadonlyArray<string> => {
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column]?.length ?? 0)),
  )
  const line = (cells: ReadonlyArray<string>) =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd()
  return [line(header), ...rows.map(line)]
}

// One row per CLI: id, installed version, pinned version, status and the detail ("-" when there is none).
export const renderDoctor = (reports: ReadonlyArray<DoctorView>): ReadonlyArray<string> =>
  renderTable(
    ["executor", "installed", "pinned", "status", "detail"],
    reports.map((report) => [
      report.executor,
      report.installed ?? "-",
      report.pinned,
      report.status,
      report.detail ?? "-",
    ]),
  )

// Any status but ok is an issue for --strict (missing, auth_missing or drift).
export const doctorHasIssues = (reports: ReadonlyArray<DoctorView>): boolean =>
  reports.some((report) => report.status !== "ok")

// GET /executors/doctor: the reports of this host as the core sees it, decoded at the boundary.
export const doctorReports = (
  settings: Settings,
): Effect.Effect<ReadonlyArray<DoctorView>, HttpError | SchemaViolation> =>
  new ApiClient(settings.url, settings.token)
    .get("/executors/doctor", DoctorBody)
    .pipe(Effect.map((body) => body.reports))

// executors doctor [--strict]: exit 0 whenever the check ran; --strict exits 1 when any CLI is not ok.
const doctorCommand = (argv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const strict = argv.includes("--strict")
    const { flags, positionals } = yield* parseArgs(
      argv.filter((arg) => arg !== "--strict"),
      SETTINGS_FLAGS,
    )
    if (positionals.length > 0) {
      return yield* Effect.fail(new UsageError({ message: DOCTOR_USAGE }))
    }
    const settings = yield* resolveSettings(flags, process.env)
    const reports = yield* doctorReports(settings)
    for (const line of renderDoctor(reports)) {
      yield* Console.log(line)
    }
    if (strict && doctorHasIssues(reports)) {
      yield* Effect.sync(() => {
        process.exitCode = 1
      })
    }
  })

// executors list: every executor of the registry with its availability and quota (GET /executors/quota).
const listCommand = (argv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const { flags, positionals } = yield* parseArgs(argv, SETTINGS_FLAGS)
    if (positionals.length > 0) {
      return yield* Effect.fail(new UsageError({ message: LIST_USAGE }))
    }
    const settings = yield* resolveSettings(flags, process.env)
    for (const line of renderQuota(yield* quotaList(settings))) {
      yield* Console.log(line)
    }
  })

// What a recording would do, printed without running anything. The live run is T-166's: it spends quota.
export const recordPlan = (executor: Recordable, version: string) => ({
  status: "dry-run",
  executor,
  bin: BIN_OF[executor],
  version,
  fixtures: `packages/executors/test/fixtures/${executor}/${version}`,
  prompts: PROMPTS,
  manifest: {
    version,
    recordedAt: "<ISO instant of the live run>",
    command: `${BIN_OF[executor]} <argv of each prompt, filled by the live recorder>`,
  },
})

// executors record --executor <id> --version <semver> --dry-run. Without --dry-run the command refuses: the live
// recording is NOT_RUN until the live probe exists (T-166).
const recordCommand = (argv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const dryRun = argv.includes("--dry-run")
    const { flags, positionals } = yield* parseArgs(
      argv.filter((arg) => arg !== "--dry-run"),
      ["executor", "version"],
    )
    if (positionals.length > 0) {
      return yield* Effect.fail(new UsageError({ message: RECORD_USAGE }))
    }
    const executor = yield* Schema.decodeUnknownEffect(Recordable)(flags.executor ?? "").pipe(
      Effect.mapError(
        () => new UsageError({ message: `--executor expects one of ${RECORDABLE.join(", ")}` }),
      ),
    )
    const version = yield* Schema.decodeUnknownEffect(Semver)(flags.version ?? "").pipe(
      Effect.mapError(() => new UsageError({ message: "--version expects a semver, e.g. 0.155.1" })),
    )
    if (!dryRun) {
      return yield* Effect.fail(
        new UsageError({
          message:
            "NOT_RUN: executors record needs the live probe (T-166) and spends quota; add --dry-run for the plan",
        }),
      )
    }
    yield* Console.log(JSON.stringify(recordPlan(executor, version), null, 2))
  })

// Dispatch of `executors doctor | list | record`. The command is separate from `executor quota` (the Bots' executors).
export const executorsCommand = (
  argv: ReadonlyArray<string>,
): Effect.Effect<void, UsageError | HttpError | SchemaViolation> => {
  const [sub, ...rest] = argv
  switch (sub) {
    case "doctor":
      return doctorCommand(rest)
    case "list":
      return listCommand(rest)
    case "record":
      return recordCommand(rest)
    default:
      return Effect.fail(
        new UsageError({
          message:
            sub === undefined
              ? "missing executors subcommand (doctor|list|record)"
              : `unknown executors subcommand: ${sub}`,
        }),
      )
  }
}
