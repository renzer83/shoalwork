import type { Artifact } from "@shoalwork/contracts"
import { type GhClientShape, GIT_CREDENTIAL_ARGV, withGitToken } from "@shoalwork/currents"
import type { ExecResult, TankContext, TankShape } from "@shoalwork/tank"
import { Data, Effect, Redacted } from "effect"
import { clip, type DeliveryStep, describeFailure, EVIDENCE_MAX } from "./verdict.js"

// Text the Lead sends to git and GitHub never names the tool that wrote the code (index.md §17).
export const AI_MENTION = /claude|anthropic|openai|codex|ai-generated|co-authored-by/i

// Each git/gh call; the whole run is already bounded by the task's time budget.
const STEP_TIMEOUT_MS = 300_000

export class DeliveryFailed extends Data.TaggedError("DeliveryFailed")<{
  readonly step: DeliveryStep
  readonly message: string
  readonly files?: ReadonlyArray<string>
}> {}

export interface DeliveryInput {
  readonly taskId: string
  readonly title: string
  readonly base: string
  readonly issue: number | undefined
  // A GitHub App installation (T-084): gh acts as it, and git pushes with its token. Absent = the Bot's own login.
  readonly installation?: { readonly id: number; readonly token: Redacted.Redacted<string> } | undefined
}

export const cleanText = (text: string, fallback: string): string => (AI_MENTION.test(text) ? fallback : text)

// Commit message and PR title: the issue title, or a neutral one when that title names a tool.
export const deliveryTitle = (title: string, issue: number | undefined): string =>
  cleanText(title, issue === undefined ? "Bot change" : `Resolve issue #${issue}`)

export const deliveryBody = (taskId: string, issue: number | undefined): string =>
  cleanText(issue === undefined ? `Task ${taskId}` : `Closes #${issue}`, "")

// Credentials embedded in URLs must never reach evidence.
const redact = (text: string): string => text.replace(/:\/\/[^@/\s]+@/g, "://***@")

const firstLine = (text: string): string => clip(redact(text.trim().split("\n")[0] ?? ""), EVIDENCE_MAX)

export const exitMessage = (argv: ReadonlyArray<string>, result: ExecResult): string => {
  // Identity options (-c key=value) are not part of the program name in the message.
  const program = argv
    .filter((arg) => arg !== "-c" && !arg.startsWith("user.") && !arg.startsWith("credential."))
    .slice(0, 2)
    .join(" ")
  if (result.timedOut) return `${program} timed out`
  const detail = firstLine(result.stderr)
  return detail === ""
    ? `${program} exited ${result.exitCode}`
    : `${program} exited ${result.exitCode}: ${detail}`
}

export const execStep = (
  tank: TankShape,
  ctx: TankContext,
  step: DeliveryStep,
  argv: ReadonlyArray<string>,
): Effect.Effect<ExecResult, DeliveryFailed> =>
  tank
    .exec(ctx, argv, { timeoutMs: STEP_TIMEOUT_MS })
    .pipe(Effect.mapError((error) => new DeliveryFailed({ step, message: describeFailure(error).message })))

export const mustSucceed = (
  tank: TankShape,
  ctx: TankContext,
  step: DeliveryStep,
  argv: ReadonlyArray<string>,
): Effect.Effect<ExecResult, DeliveryFailed> =>
  Effect.gen(function* () {
    const result = yield* execStep(tank, ctx, step, argv)
    if (result.exitCode !== 0 || result.timedOut) {
      return yield* Effect.fail(new DeliveryFailed({ step, message: exitMessage(argv, result) }))
    }
    return result
  })

// Identity comes from the Bot's name on a reserved domain (.invalid never resolves to a real mailbox).
export const commitArgv = (botName: string, title: string): ReadonlyArray<string> => [
  "git",
  "-c",
  `user.name=${botName}`,
  "-c",
  `user.email=${botName}@bots.shoalwork.invalid`,
  "commit",
  `--message=${title}`,
]

// Commits everything the Bot changed in its worktree, pushes the branch and opens the PR. Git commands are argv
// only (no shell) and run in the Bot's Tank; the PR goes through GhClient, which runs gh with the Bot's env.
export const deliverCode = (
  tank: TankShape,
  ctx: TankContext,
  input: DeliveryInput,
  gh: GhClientShape,
): Effect.Effect<Artifact, DeliveryFailed> =>
  Effect.gen(function* () {
    const branch = ctx.worktree?.branch
    if (branch === undefined) {
      return yield* Effect.fail(new DeliveryFailed({ step: "commit", message: "no worktree to deliver" }))
    }
    const title = deliveryTitle(input.title, input.issue)
    const body = deliveryBody(input.taskId, input.issue)

    yield* mustSucceed(tank, ctx, "commit", ["git", "add", "-A"])
    // Exit 0 = nothing staged, 1 = something staged, anything else = git failed.
    const staged = yield* execStep(tank, ctx, "commit", ["git", "diff", "--cached", "--quiet"])
    if (staged.exitCode === 0 && !staged.timedOut) {
      return yield* Effect.fail(new DeliveryFailed({ step: "commit", message: "no changes" }))
    }
    if (staged.exitCode !== 1 || staged.timedOut) {
      return yield* Effect.fail(
        new DeliveryFailed({ step: "commit", message: exitMessage(["git", "diff"], staged) }),
      )
    }

    // The commit identity is the Bot's, passed per command: the Bot's HOME has no git config of its own.
    yield* mustSucceed(tank, ctx, "commit", commitArgv(ctx.botName, title))
    // An installation's token travels in the env of this one push (withGitToken); argv only names the helper.
    const installation = input.installation
    if (installation === undefined) {
      yield* mustSucceed(tank, ctx, "push", ["git", "push", "-u", "origin", branch])
    } else {
      yield* mustSucceed(tank, withGitToken(ctx, Redacted.value(installation.token)), "push", [
        "git",
        ...GIT_CREDENTIAL_ARGV,
        "push",
        "-u",
        "origin",
        branch,
      ])
    }
    const request = { title, body, base: input.base }
    const prCall =
      installation === undefined
        ? gh.prCreate(ctx, request)
        : gh.prCreate(ctx, request, { installationId: installation.id })
    const pr = yield* prCall.pipe(
      Effect.mapError((error) => new DeliveryFailed({ step: "pr", message: error.message })),
    )
    return { kind: "pr", ref: pr.url }
  })
