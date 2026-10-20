import { Context, Duration, Effect, Layer, Schema } from "effect"
import {
  type GhContext,
  type GhEnv,
  GhError,
  type GhOutput,
  type GhRun,
  hostGhEnv,
  runGhProcess,
} from "./gh-process.js"
import { cleanText } from "./webhook.js"

// Every gh call goes through here: argv only (no shell), `--` before positional numbers, and free text as an
// attached `--flag=value`, so a value that starts with a dash stays a value.
const CALL_TIMEOUT_MS = 120_000
// Watch mode polls the checks this often until they are decided or the caller's deadline passes.
const CHECKS_POLL = Duration.seconds(10)

export interface GhClientShape {
  readonly issueView: (
    repo: string,
    n: number,
  ) => Effect.Effect<{ title: string; body: string; labels: ReadonlyArray<string> }, GhError>
  readonly prCreate: (
    ctx: GhContext,
    o: { title: string; body: string; base: string; draft?: boolean },
  ) => Effect.Effect<{ url: string; number: number }, GhError>
  // Decided from the checks' own JSON (bucket and state), not from the exit code. Without valid JSON it is a GhError.
  readonly prChecks: (
    repo: string,
    n: number,
    o: { watch: boolean; timeoutMs: number },
  ) => Effect.Effect<"pass" | "fail" | "pending", GhError>
  readonly prMerge: (
    repo: string,
    n: number,
    o: { squash: true; auto: boolean; deleteBranch: boolean },
  ) => Effect.Effect<void, GhError>
  readonly prView: (
    repo: string,
    n: number,
  ) => Effect.Effect<{ state: string; mergeable: string; headRef: string }, GhError>
}

export class GhClient extends Context.Service<GhClient, GhClientShape>()("@shoalwork/GhClient") {}

// Argv builders: pure, so the arguments are tested without a process.
export const issueViewArgv = (repo: string, n: number): ReadonlyArray<string> => [
  "gh",
  "issue",
  "view",
  "--repo",
  repo,
  "--json",
  "title,body,labels",
  "--",
  String(n),
]

export const prCreateArgv = (o: {
  title: string
  body: string
  base: string
  draft?: boolean
}): ReadonlyArray<string> => [
  "gh",
  "pr",
  "create",
  `--title=${o.title}`,
  `--body=${o.body}`,
  `--base=${o.base}`,
  ...(o.draft === true ? ["--draft"] : []),
]

export const prChecksArgv = (repo: string, n: number): ReadonlyArray<string> => [
  "gh",
  "pr",
  "checks",
  "--repo",
  repo,
  "--json",
  "bucket,state",
  "--",
  String(n),
]

export const prMergeArgv = (
  repo: string,
  n: number,
  o: { auto: boolean; deleteBranch: boolean },
): ReadonlyArray<string> => [
  "gh",
  "pr",
  "merge",
  "--repo",
  repo,
  "--squash",
  ...(o.auto ? ["--auto"] : []),
  ...(o.deleteBranch ? ["--delete-branch"] : []),
  "--",
  String(n),
]

export const prViewArgv = (repo: string, n: number): ReadonlyArray<string> => [
  "gh",
  "pr",
  "view",
  "--repo",
  repo,
  "--json",
  "state,mergeable,headRefName",
  "--",
  String(n),
]

const IssueJson = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
  labels: Schema.Array(Schema.Struct({ name: Schema.String })),
})
const PrViewJson = Schema.Struct({
  state: Schema.String,
  mergeable: Schema.String,
  headRefName: Schema.String,
})
const ChecksJson = Schema.Array(Schema.Struct({ bucket: Schema.String, state: Schema.String }))
const decodeIssue = Schema.decodeUnknownEffect(Schema.fromJsonString(IssueJson))
const decodePrView = Schema.decodeUnknownEffect(Schema.fromJsonString(PrViewJson))
const decodeChecks = Schema.decodeUnknownEffect(Schema.fromJsonString(ChecksJson))

const FAILED_STATES: ReadonlySet<string> = new Set([
  "FAILURE",
  "ERROR",
  "CANCELLED",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
])
const PENDING_STATES: ReadonlySet<string> = new Set([
  "PENDING",
  "QUEUED",
  "IN_PROGRESS",
  "WAITING",
  "REQUESTED",
])

// One verdict for all checks: any failure fails; no checks yet, or any still running, is pending; otherwise pass.
export const checksVerdict = (
  checks: ReadonlyArray<{ readonly bucket: string; readonly state: string }>,
): "pass" | "fail" | "pending" => {
  if (
    checks.some(
      (check) => check.bucket === "fail" || check.bucket === "cancel" || FAILED_STATES.has(check.state),
    )
  ) {
    return "fail"
  }
  if (
    checks.length === 0 ||
    checks.some((check) => check.bucket === "pending" || PENDING_STATES.has(check.state))
  ) {
    return "pending"
  }
  return "pass"
}

const PULL_REQUEST_LINE = /^https:\/\/\S+\/pull\/(\d+)$/

// gh prints the URL of the PR it created on a line of its own.
export const pullRequestFromOutput = (stdout: string): { url: string; number: number } | undefined => {
  for (const raw of stdout.split("\n")) {
    const line = raw.trim()
    const match = PULL_REQUEST_LINE.exec(line)
    if (match !== null) return { url: line, number: Number(match[1]) }
  }
  return undefined
}

// Only the first line of stderr, with URL credentials and token-shaped strings redacted. Nothing after it is kept.
const detailOf = (stderr: string): string => {
  const first = (stderr.trim().split("\n")[0] ?? "").slice(0, 2_000)
  return cleanText(first.replace(/:\/\/[^@/\s]+@/g, "://***@"), 200)
}

const exitMessage = (op: string, out: GhOutput): string => {
  if (out.timedOut) return `${op} timed out`
  const detail = detailOf(out.stderr)
  return detail === "" ? `${op} exited ${out.exitCode}` : `${op} exited ${out.exitCode}: ${detail}`
}

const requireSuccess =
  (op: string) =>
  (out: GhOutput): Effect.Effect<GhOutput, GhError> =>
    out.exitCode === 0 && !out.timedOut
      ? Effect.succeed(out)
      : Effect.fail(new GhError({ op, message: exitMessage(op, out) }))

export const makeGhClient = (run: GhRun, hostEnv: GhEnv): GhClientShape => {
  const hostCall = (op: string, argv: ReadonlyArray<string>) =>
    run(op, argv, hostEnv, undefined, CALL_TIMEOUT_MS).pipe(Effect.flatMap(requireSuccess(op)))

  const checksOnce = (repo: string, n: number) => {
    const op = "gh pr checks"
    return run(op, prChecksArgv(repo, n), hostEnv, undefined, CALL_TIMEOUT_MS).pipe(
      Effect.flatMap((out) => {
        if (out.timedOut) return Effect.fail(new GhError({ op, message: exitMessage(op, out) }))
        return decodeChecks(out.stdout).pipe(
          Effect.map((checks) => checksVerdict(checks)),
          Effect.mapError(
            () =>
              new GhError({
                op,
                message: out.exitCode === 0 ? `${op} printed unexpected output` : exitMessage(op, out),
              }),
          ),
        )
      }),
    )
  }

  return {
    issueView: (repo, n) =>
      hostCall("gh issue view", issueViewArgv(repo, n)).pipe(
        Effect.flatMap((out) =>
          decodeIssue(out.stdout).pipe(
            Effect.mapError(
              () => new GhError({ op: "gh issue view", message: "gh issue view printed unexpected output" }),
            ),
          ),
        ),
        Effect.map((issue) => ({
          title: issue.title,
          body: issue.body,
          labels: issue.labels.map((label) => label.name),
        })),
      ),
    prCreate: (ctx, o) =>
      run("gh pr create", prCreateArgv(o), ctx.env, ctx.cwd, CALL_TIMEOUT_MS).pipe(
        Effect.flatMap(requireSuccess("gh pr create")),
        Effect.flatMap((out) => {
          const pr = pullRequestFromOutput(out.stdout)
          return pr === undefined
            ? Effect.fail(new GhError({ op: "gh pr create", message: "gh printed no pull request URL" }))
            : Effect.succeed(pr)
        }),
      ),
    prChecks: (repo, n, o) => {
      const deadline = Date.now() + o.timeoutMs
      const poll = (): Effect.Effect<"pass" | "fail" | "pending", GhError> =>
        checksOnce(repo, n).pipe(
          Effect.flatMap((verdict) =>
            verdict !== "pending" || !o.watch || Date.now() >= deadline
              ? Effect.succeed(verdict)
              : Effect.sleep(CHECKS_POLL).pipe(Effect.flatMap(poll)),
          ),
        )
      return poll()
    },
    prMerge: (repo, n, o) => hostCall("gh pr merge", prMergeArgv(repo, n, o)).pipe(Effect.asVoid),
    prView: (repo, n) =>
      hostCall("gh pr view", prViewArgv(repo, n)).pipe(
        Effect.flatMap((out) =>
          decodePrView(out.stdout).pipe(
            Effect.mapError(
              () => new GhError({ op: "gh pr view", message: "gh pr view printed unexpected output" }),
            ),
          ),
        ),
        Effect.map((pr) => ({ state: pr.state, mergeable: pr.mergeable, headRef: pr.headRefName })),
      ),
  }
}

export const GhClientLive = (options: {
  readonly baseEnv: Readonly<Record<string, string | undefined>>
}): Layer.Layer<GhClient> => Layer.succeed(GhClient, makeGhClient(runGhProcess, hostGhEnv(options.baseEnv)))
