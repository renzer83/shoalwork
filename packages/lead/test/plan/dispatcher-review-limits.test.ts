import { it } from "@effect/vitest"
import { Beacon } from "@shoalwork/beacon"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import {
  checked,
  DispatchLayer,
  fakeIntegration,
  okVerdict,
  setupDispatch,
  verified,
} from "./dispatch-support.js"
import {
  branchOf,
  CLAUDE,
  CODEX,
  FIX,
  play,
  playCut,
  reviewed,
  reviewsOf,
  started,
  verdictOf,
} from "./review-support.js"

describe("Dispatcher review step limits", () => {
  it.effect("a review cut at 2000 characters is read in full from the executor's own result", () =>
    Effect.gen(function* () {
      const full = `${Array.from({ length: 10 }, () => `[MINOR] ${"p".repeat(250)}`).join("\n")}\n[BLOCKER] real problem`
      const cut = full.slice(0, 2000)
      const beacon = yield* Beacon
      const { result, specs } = yield* playCut(beacon, full, cut, true)
      expect(specs.some((spec) => spec.title === FIX)).toBe(true)
      expect(result.steps.at(-1)?.status).toBe("done")
    }).pipe(Effect.provide(DispatchLayer)),
  )

  it.effect("a cut review whose full text is not available is blocked as needs_human, never accepted", () =>
    Effect.gen(function* () {
      const full = `${Array.from({ length: 10 }, () => `[MINOR] ${"p".repeat(250)}`).join("\n")}\n[BLOCKER] real problem`
      const beacon = yield* Beacon
      const { result, specs } = yield* playCut(beacon, full, full.slice(0, 2000), false)
      expect(result.steps.at(-1)?.status).toBe("blocked")
      expect(result.steps.at(-1)?.reason).toContain("cut short")
      expect(specs.some((spec) => spec.title === FIX)).toBe(false)
    }).pipe(Effect.provide(DispatchLayer)),
  )

  it.effect(
    "the review budget is shared: the fix gets what the first review left, the second review what is left after",
    () =>
      Effect.gen(function* () {
        const { specs, result } = yield* play([checked("a")], {
          worker: CLAUDE,
          answer: (round) => verdictOf(round === 1 ? "[BLOCKER] x" : "NONE", round === 1 ? 2 : 1),
        })
        // The review step has 5 seconds: review 1 spends 2, the fix is told 3 and (here) spends 0, review 2 gets 3.
        expect(specs.find((spec) => spec.title === FIX)?.budget.seconds).toBe(3)
        expect(reviewsOf(specs)[1]?.budget.seconds).toBe(3)
        expect(result.state).toBe("done")
      }).pipe(Effect.provide(DispatchLayer)),
  )

  it.effect(
    "a review that spends the whole budget leaves nothing for the fix: the step fails, no fix runs",
    () =>
      Effect.gen(function* () {
        const { specs, result, integration } = yield* play([checked("a")], {
          worker: CLAUDE,
          answer: () => verdictOf("[BLOCKER] x", 5),
        })
        expect(specs.some((spec) => spec.title === FIX)).toBe(false)
        expect(result.steps.at(-1)?.status).toBe("failed")
        expect(result.steps.at(-1)?.reason).toContain("budget is spent")
        expect(integration.prs).toEqual([])
      }).pipe(Effect.provide(DispatchLayer)),
  )

  it.effect("the excluded executors include those of discarded attempts and of every work step", () =>
    Effect.gen(function* () {
      const beacon = yield* Beacon
      const integration = yield* fakeIntegration()
      const a = checked("a")
      const b = checked("b")
      let nth = 0
      const made = yield* setupDispatch(reviewed([a, b]), {
        integration,
        // Step a fails verification once: its first run was on codex, the retry on claude-code.
        verify: ({ step: s }) => (s.id === a.id && nth === 1 ? verified("failed", ["x"]) : verified("ok")),
        run: ({ step: s, spec }) =>
          Effect.gen(function* () {
            if (spec.review !== undefined) return verdictOf("NONE")
            nth += s.id === a.id ? 1 : 0
            yield* started(beacon, spec, s.id === a.id && nth === 1 ? CODEX : CLAUDE)
            return okVerdict(branchOf(s.id))
          }),
      })
      yield* made.dispatcher.run(made.plan, made.assignments)
      const [review] = reviewsOf(made.specs)
      expect([...(review?.review?.excludeExecutors ?? [])].sort()).toEqual([CLAUDE, CODEX].sort())
    }).pipe(Effect.provide(DispatchLayer)),
  )
})
