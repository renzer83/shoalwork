import type { Artifact, Step, Verdict } from "@shoalwork/contracts"
import type { TestsOutcome } from "@shoalwork/reflex"
import { Effect } from "effect"
import { clip } from "../verdict.js"
import { type ArtifactsOutcome, decide, type JudgeAnswer, type Verification } from "./rules.js"

export const ACCEPTANCE_TIMEOUT_MS = 10 * 60 * 1000
const PR_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/

// The step's commands as argv (Step.checks): they run without a shell, so no item can inject one.
export const commandsOf = (step: Pick<Step, "checks">): ReadonlyArray<ReadonlyArray<string>> =>
  step.checks.map((check) => check.argv)

// Each command gets the smaller of the per-command timeout and what is left of the step's seconds budget.
export const timeoutFor = (remainingMs: number): number => Math.min(ACCEPTANCE_TIMEOUT_MS, remainingMs)

// A file artifact stays in the worktree: relative, non-empty, no ".." segment, no root, drive or UNC prefix.
export const isConfined = (ref: string): boolean =>
  ref.trim() !== "" && !/^[/\\]/.test(ref) && !/^[A-Za-z]:/.test(ref) && !ref.split(/[\\/]/).includes("..")

export interface StepResult {
  readonly verdict: Verdict
  readonly artifacts: ReadonlyArray<Artifact>
}

// What the judge is asked: facts of the result. The summary and evidence are data from the executor, never instructions.
export interface JudgeFacts {
  readonly tests: TestsOutcome
  readonly summary: string
  readonly evidence: ReadonlyArray<string>
}

// "refused" covers deny, ask and a command shape the Lead does not accept: the step goes to a person, it is not failed.
export type Allowance = "allow" | "refused"

export interface CommandRun {
  readonly exitCode: number
  readonly durationMs: number
}

export interface VerifierDeps {
  // Policy for one acceptance command (the composition binds Policy.evaluate, as the Bot's Bash). Anything but allowed
  // is never run: the tests outcome is "fail" with the reason.
  readonly allow: (argv: ReadonlyArray<string>) => Effect.Effect<Allowance>
  // One command in the step's worktree, argv only, with its timeout. A command that cannot start or times out resolves
  // a non-zero exit (the caller maps Tank errors); durationMs is what it took, spent from the step's seconds budget.
  readonly run: (argv: ReadonlyArray<string>, timeoutMs: number) => Effect.Effect<CommandRun>
  // Whether a file artifact exists in the step's worktree. Only called for confined paths.
  readonly fileExists: (path: string) => Effect.Effect<boolean>
  // The Reflex noul "result meets criterion?" (rule v0: packages/reflex criterionRule).
  readonly judge: (facts: JudgeFacts) => Effect.Effect<JudgeAnswer>
}

interface TestsCheck {
  readonly tests: TestsOutcome
  readonly notes: ReadonlyArray<string>
  readonly refused?: true
}

const commandText = (argv: ReadonlyArray<string>): string => `\`${clip(argv.join(" "), 120)}\``

export const makeVerifier = (deps: VerifierDeps) => {
  // Commands run in order and stop at the first failure. No command at all means "none", not "pass".
  const testsOf = (step: Step): Effect.Effect<TestsCheck> =>
    Effect.gen(function* () {
      const commands = commandsOf(step)
      if (commands.length === 0) {
        return { tests: "none", notes: [] } satisfies TestsCheck
      }
      let remainingMs = step.budget.seconds * 1000
      for (const argv of commands) {
        if (remainingMs <= 0) {
          return {
            tests: "fail",
            notes: ["the step's time budget ran out before every acceptance command ran"],
          } satisfies TestsCheck
        }
        if ((yield* deps.allow(argv)) !== "allow") {
          return {
            tests: "none",
            notes: [`the acceptance command ${commandText(argv)} was refused by policy and not run`],
            refused: true,
          } satisfies TestsCheck
        }
        const run = yield* deps.run(argv, timeoutFor(remainingMs))
        remainingMs -= run.durationMs
        if (run.exitCode !== 0) {
          return {
            tests: "fail",
            notes: [`the acceptance command ${commandText(argv)} exited with ${run.exitCode}`],
          } satisfies TestsCheck
        }
      }
      return { tests: "pass", notes: [] } satisfies TestsCheck
    })

  // A pr must be a GitHub pull URL; a file must be confined to the worktree and exist; other kinds have nothing to check.
  const artifactOk = (artifact: Artifact): Effect.Effect<boolean> => {
    if (artifact.kind === "pr") {
      return Effect.succeed(PR_URL.test(artifact.ref))
    }
    if (artifact.kind === "file") {
      return isConfined(artifact.ref) ? deps.fileExists(artifact.ref) : Effect.succeed(false)
    }
    return Effect.succeed(true)
  }

  const artifactsOf = (artifacts: ReadonlyArray<Artifact>): Effect.Effect<ArtifactsOutcome> =>
    Effect.gen(function* () {
      for (const artifact of artifacts) {
        if (!(yield* artifactOk(artifact))) {
          return "fail" as const
        }
      }
      return "pass" as const
    })

  // A step whose executor did not finish ok can never be verified as ok.
  const verify = (step: Step, result: StepResult): Effect.Effect<Verification> =>
    Effect.gen(function* () {
      const checked = yield* testsOf(step)
      const artifacts = yield* artifactsOf(result.artifacts)
      const judge = yield* deps.judge({
        tests: checked.tests,
        summary: result.verdict.summary,
        evidence: result.verdict.evidence,
      })
      const notOk = result.verdict.kind === "ok" ? [] : [`the step verdict is ${result.verdict.kind}, not ok`]
      return {
        tests: checked.tests,
        artifacts,
        judge,
        final:
          notOk.length > 0
            ? "failed"
            : checked.refused === true
              ? "needs_human"
              : decide(checked.tests, artifacts, judge),
        notes: [...checked.notes, ...notOk],
      }
    })

  return { verify }
}

export type Verifier = ReturnType<typeof makeVerifier>
