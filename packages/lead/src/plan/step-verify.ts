import type { BotRegistryShape } from "@shoalwork/bots"
import { type BotId, type Step, StepId, type TaskId, type TaskSpec, type Verdict } from "@shoalwork/contracts"
import type { PolicyShape } from "@shoalwork/policy"
import type { TankContext, TankShape } from "@shoalwork/tank"
import { Data, Effect, Option, Schema } from "effect"
import { stepIdFor } from "../verdict.js"
import type { JudgeAnswer, Verification } from "../verify/rules.js"
import { type Allowance, type CommandRun, type JudgeFacts, makeVerifier } from "../verify/verifier.js"
import { checkCommandOk } from "./check-command.js"

// What the dispatcher asks about a work step that finished ok: its checks run in a fresh worktree of its branch.
export interface VerifyInput {
  readonly root: TaskSpec
  readonly step: Step
  readonly botId: BotId
  readonly taskId: TaskId
  // The branch the step pushed (or, without one, the base it started from). The worker's worktree is on this branch.
  readonly base: string
  readonly verdict: Verdict
}

export type VerifyStep = (input: VerifyInput) => Effect.Effect<Verification>

export interface StepVerifyDeps {
  readonly tank: TankShape
  readonly bots: BotRegistryShape
  // Policy for one check command of a Bot. Anything but a clear yes is a no.
  readonly allow: (botId: BotId, argv: ReadonlyArray<string>) => Effect.Effect<Allowance>
  // The Reflex noul "result meets criterion?" (criterionRule is the v0 rule).
  readonly judge: (facts: JudgeFacts) => Effect.Effect<JudgeAnswer>
}

// Words the Policy lexer and the argv agree on: the Policy sees the joined text, the Tank runs the argv, so a word that
// a shell lexer could split, quote or expand is refused before the Policy is even asked.
const PLAIN_WORD = /^[A-Za-z0-9_./:=@%+,-]+$/

// A check command is first held to the shapes the Lead accepts (check-command.ts), then judged as the Bot's Bash.
// Without a Policy, or when it says anything but allow, the command is refused (fail-closed).
export const policyAllow =
  (policy: Pick<PolicyShape, "evaluate"> | undefined) =>
  (botId: BotId, argv: ReadonlyArray<string>): Effect.Effect<Allowance> =>
    policy === undefined || !checkCommandOk(argv) || !argv.every((word) => PLAIN_WORD.test(word))
      ? Effect.succeed("refused")
      : policy
          .evaluate(botId, { tool: "Bash", input: { command: argv.join(" ") } })
          .pipe(Effect.map((decision) => (decision.effect === "allow" ? "allow" : "refused")))

const NOT_RUN: CommandRun = { exitCode: 127, durationMs: 0 }
const TIMED_OUT = 124

// The verification could not even start: not the step's fault, so a person decides.
const unavailable = (note: string): Verification => ({
  tests: "none",
  artifacts: "pass",
  judge: { value: false, confidence: 0 },
  final: "needs_human",
  notes: [note],
})

class WorktreeGone extends Data.TaggedError("WorktreeGone")<{ readonly branch: string }> {}

const CHECK_WORKTREE_ATTEMPT = -2
const decodeStepId = Schema.decodeUnknownOption(StepId)

export const makeStepVerify = (deps: StepVerifyDeps): VerifyStep => {
  // The checks run in the worker's own worktree (the one its run kept, with its installed dependencies), found by the
  // branch it pushed. A plan without a repo has no worker worktree: a fresh context of its own is used. Either way it
  // goes away with the scope.
  const open = (input: VerifyInput) =>
    Effect.acquireRelease(
      Effect.gen(function* () {
        const bot = yield* deps.bots.get(input.botId)
        const repo = input.root.repo
        if (repo === undefined) {
          return yield* deps.tank.prepare(bot, { stepId: stepIdFor(input.taskId, CHECK_WORKTREE_ATTEMPT) })
        }
        const kept = (yield* deps.tank.worktrees(bot, repo.url)).find((tree) => tree.branch === input.base)
        const stepId = decodeStepId(input.base.split("/").at(-1))
        if (kept === undefined || Option.isNone(stepId)) {
          return yield* Effect.fail(new WorktreeGone({ branch: input.base }))
        }
        return yield* deps.tank.prepare(bot, {
          stepId: stepId.value,
          repo: { ...repo, base: input.base },
          reuse: { path: kept.path, branch: kept.branch },
        })
      }),
      (ctx: TankContext) => deps.tank.release(ctx, { keepWorktree: false }).pipe(Effect.ignore),
    )

  return (input) =>
    Effect.scoped(
      Effect.gen(function* () {
        // No command, no worktree: only steps with checks pay for one.
        const ctx = input.step.checks.length === 0 ? undefined : yield* open(input)
        const verifier = makeVerifier({
          allow: (argv) => deps.allow(input.botId, argv),
          run: (argv, timeoutMs) =>
            ctx === undefined
              ? Effect.succeed(NOT_RUN)
              : deps.tank.exec(ctx, argv, { timeoutMs }).pipe(
                  Effect.map((result) => ({
                    exitCode: result.timedOut ? TIMED_OUT : result.exitCode,
                    durationMs: result.durationMs,
                  })),
                  Effect.catch(() => Effect.succeed(NOT_RUN)),
                ),
          // File artifacts are not produced by plan steps yet; until they are, none exists (fail-closed).
          fileExists: () => Effect.succeed(false),
          judge: deps.judge,
        })
        return yield* verifier.verify(input.step, { verdict: input.verdict, artifacts: [] })
      }),
    ).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          unavailable(
            error._tag === "WorktreeGone"
              ? "the worker's worktree is no longer there, so its checks cannot run"
              : "the verification worktree could not be prepared",
          ),
        ),
      ),
    )
}
