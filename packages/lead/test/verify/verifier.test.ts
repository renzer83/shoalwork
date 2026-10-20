import { it } from "@effect/vitest"
import { type Artifact, newStepId, type Step, type Verdict } from "@shoalwork/contracts"
import { criterionRule, type TestsOutcome } from "@shoalwork/reflex"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { type ArtifactsOutcome, decide, type JudgeAnswer } from "../../src/verify/rules.js"
import {
  ACCEPTANCE_TIMEOUT_MS,
  commandsOf,
  isConfined,
  makeVerifier,
  timeoutFor,
} from "../../src/verify/verifier.js"

const step = (acceptance: ReadonlyArray<string>, seconds = 3600): Step => ({
  id: newStepId(),
  title: "step",
  prompt: "do it",
  dependsOn: [],
  acceptance,
  budget: { tokens: 1000, seconds, usd: 0.1 },
  tier: "heavy",
  parallelizable: false,
})

const verdict = (kind: Verdict["kind"] = "ok"): Verdict => ({
  kind,
  summary: "done",
  evidence: [],
  cost: { tokensIn: 0, tokensOut: 0, usd: 0, seconds: 1 },
})

// "pass" runs one command that exits 0, "fail" one that exits 1, "none" has no command.
const acceptanceFor = (tests: TestsOutcome): ReadonlyArray<string> =>
  tests === "none" ? ["the feature works"] : ["$ pnpm test"]

const artifactsFor = (artifacts: ArtifactsOutcome): ReadonlyArray<Artifact> =>
  artifacts === "pass"
    ? [{ kind: "pr", ref: "https://github.com/acme/app/pull/12" }]
    : [{ kind: "pr", ref: "https://example.com/not-a-pr" }]

// Every dependency is a fake that records what it was asked; the judge is the real rule v0.
const fakes = (exitCode: (argv: ReadonlyArray<string>) => number = () => 0) => {
  const runs: Array<{ argv: ReadonlyArray<string>; timeoutMs: number }> = []
  const files: Array<string> = []
  return {
    runs,
    files,
    deps: {
      allow: () => Effect.succeed(true),
      run: (argv: ReadonlyArray<string>, timeoutMs: number) =>
        Effect.sync(() => {
          runs.push({ argv, timeoutMs })
          return { exitCode: exitCode(argv), durationMs: 1 }
        }),
      fileExists: (path: string) =>
        Effect.sync(() => {
          files.push(path)
          return true
        }),
      judge: ({ tests }: { readonly tests: TestsOutcome }) => Effect.succeed(criterionRule(tests)),
    },
  }
}

describe("Verifier.verify", () => {
  // tests x artifacts: the real judge gives 0.9 when tests exist and 0.5 (a guess) when they do not.
  it.effect.each([
    ["pass", "pass", "ok"],
    ["pass", "fail", "failed"],
    ["fail", "pass", "failed"],
    ["fail", "fail", "failed"],
    ["none", "pass", "needs_human"],
    ["none", "fail", "failed"],
  ] as const)("tests %s, artifacts %s -> %s", ([tests, artifacts, final]) =>
    Effect.gen(function* () {
      const { deps } = fakes((argv) => (argv[0] === "pnpm" && tests === "fail" ? 1 : 0))
      const verifier = makeVerifier(deps)
      const verification = yield* verifier.verify(step(acceptanceFor(tests)), {
        verdict: verdict(),
        artifacts: artifactsFor(artifacts),
      })
      expect(verification.tests).toBe(tests)
      expect(verification.artifacts).toBe(artifacts)
      expect(verification.final).toBe(final)
    }),
  )

  it.effect("runs each command as argv and stops at the first failure", () =>
    Effect.gen(function* () {
      const fake = fakes((argv) => (argv[0] === "lint" ? 1 : 0))
      const verifier = makeVerifier(fake.deps)
      const result = yield* verifier.verify(step(["$ lint --fix", "$ pnpm test", "$ never"]), {
        verdict: verdict(),
        artifacts: [],
      })
      expect(result.tests).toBe("fail")
      expect(fake.runs).toEqual([{ argv: ["lint", "--fix"], timeoutMs: ACCEPTANCE_TIMEOUT_MS }])
    }),
  )

  it.effect("a command refused by policy is never run and fails the tests with the reason", () =>
    Effect.gen(function* () {
      const fake = fakes()
      const verifier = makeVerifier({ ...fake.deps, allow: () => Effect.succeed(false) })
      const result = yield* verifier.verify(step(["$ rm -rf /"]), { verdict: verdict(), artifacts: [] })
      expect(fake.runs).toHaveLength(0)
      expect(result.tests).toBe("fail")
      expect(result.final).toBe("failed")
      expect(result.notes).toContain("an acceptance command was refused by policy and not run")
    }),
  )

  it.effect("each command gets the smaller of 10 minutes and what is left of the step's seconds", () =>
    Effect.gen(function* () {
      const fake = fakes()
      // 1 s budget: the first command asks for 1000 ms and reports 600 ms; the second gets the 400 ms left.
      const durations = [600, 400]
      const verifier = makeVerifier({
        ...fake.deps,
        run: (argv, timeoutMs) =>
          Effect.sync(() => {
            fake.runs.push({ argv, timeoutMs })
            return { exitCode: 0, durationMs: durations[fake.runs.length - 1] ?? 0 }
          }),
      })
      const result = yield* verifier.verify(step(["$ a", "$ b", "$ c"], 1), {
        verdict: verdict(),
        artifacts: [],
      })
      expect(fake.runs.map((run) => run.timeoutMs)).toEqual([1000, 400])
      expect(result.tests).toBe("fail")
      expect(result.notes).toContain("the step's time budget ran out before every acceptance command ran")
    }),
  )

  it("the timeout is the per-command cap when the step has time to spare", () => {
    expect(timeoutFor(3_600_000)).toBe(ACCEPTANCE_TIMEOUT_MS)
    expect(timeoutFor(5_000)).toBe(5_000)
  })

  it.effect("a step whose verdict is not ok is failed even when its tests pass", () =>
    Effect.gen(function* () {
      const verifier = makeVerifier(fakes().deps)
      const result = yield* verifier.verify(step(["$ pnpm test"]), {
        verdict: verdict("failed"),
        artifacts: [],
      })
      expect(result.tests).toBe("pass")
      expect(result.final).toBe("failed")
      expect(result.notes).toContain("the step verdict is failed, not ok")
    }),
  )

  it.effect("a file artifact outside the worktree is refused without asking the filesystem", () =>
    Effect.gen(function* () {
      const fake = fakes()
      const verifier = makeVerifier(fake.deps)
      for (const ref of ["/etc/passwd", "../secret", "docs/../../x", "C:\\x", "\\\\server\\share", ""]) {
        const result = yield* verifier.verify(step(["$ pnpm test"]), {
          verdict: verdict(),
          artifacts: [{ kind: "file", ref }],
        })
        expect(result.artifacts).toBe("fail")
      }
      expect(fake.files).toHaveLength(0)
    }),
  )

  it.effect("a file artifact inside the worktree is checked by existence; other kinds are not checked", () =>
    Effect.gen(function* () {
      const fake = fakes()
      const verifier = makeVerifier(fake.deps)
      const result = yield* verifier.verify(step(["$ pnpm test"]), {
        verdict: verdict(),
        artifacts: [
          { kind: "file", ref: "docs/out.txt" },
          { kind: "text", ref: "anything" },
        ],
      })
      expect(result.artifacts).toBe("pass")
      expect(fake.files).toEqual(["docs/out.txt"])
      expect(isConfined("docs/out.txt")).toBe(true)
    }),
  )

  it("splits commands into argv without a shell and ignores criteria", () => {
    expect(commandsOf(["$ pnpm  test --filter lead", "check the copy", "$ git status"])).toEqual([
      ["pnpm", "test", "--filter", "lead"],
      ["git", "status"],
    ])
  })
})

describe("decide (tie-break table)", () => {
  const confident = (value: boolean): JudgeAnswer => ({ value, confidence: 0.9 })
  it.each([
    ["pass", "pass", confident(false), "ok"],
    ["pass", "fail", confident(true), "failed"],
    ["fail", "pass", confident(true), "failed"],
    ["fail", "fail", confident(true), "failed"],
    ["none", "pass", { value: true, confidence: 0.7 }, "ok"],
    ["none", "pass", { value: false, confidence: 0.7 }, "failed"],
    ["none", "pass", { value: true, confidence: 0.6 }, "ok"],
    ["none", "pass", { value: true, confidence: 0.5 }, "needs_human"],
    ["none", "fail", { value: true, confidence: 0.9 }, "failed"],
  ] as const)("tests %s, artifacts %s, judge %j -> %s", (tests, artifacts, judge, final) => {
    expect(decide(tests, artifacts, judge)).toBe(final)
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1])(
    "fails closed: a judge confidence of %s never decides alone",
    (confidence) => {
      expect(decide("none", "pass", { value: true, confidence })).toBe("needs_human")
      expect(decide("none", "pass", { value: false, confidence })).toBe("needs_human")
    },
  )
})
