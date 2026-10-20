import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { checked, DispatchLayer } from "./dispatch-support.js"
import { CLAUDE, CODEX, FIX, play, reviewsOf, typesOf, verdictOf } from "./review-support.js"

describe("Dispatcher review step", () => {
  it.effect(
    "a clean review finishes the plan, on an executor other than the worker's, and is not merged",
    () =>
      Effect.gen(function* () {
        const a = checked("a")
        const { result, specs, verifications, integration, beacon } = yield* play([a], {
          worker: CLAUDE,
          answer: () => verdictOf("NONE"),
        })

        expect(result.state).toBe("done")
        expect(result.pr?.kind).toBe("pr")
        const [review] = reviewsOf(specs)
        expect(review?.review?.excludeExecutors).toEqual([CLAUDE])
        expect(review?.repo?.base).toBe("plan/abc123")
        // Only the step with checks is verified, and the review is not a work step.
        expect(verifications.map((v) => v.step.id)).toEqual([a.id])
        expect(integration.merges).toEqual(["a"])
        if (review === undefined) return expect.unreachable()
        const events = yield* typesOf(beacon, review.id)
        expect(events.find((e) => e.type === "review.decided")?.payload).toMatchObject({
          round: 1,
          decision: "accept",
          findings: 0,
        })
      }).pipe(Effect.provide(DispatchLayer)),
  )

  it.effect(
    "BLOCKER earns one fix by the plan owner, merged; the second review also avoids the fix's executor",
    () =>
      Effect.gen(function* () {
        const { result, specs, root, integration } = yield* play([checked("a")], {
          worker: CLAUDE,
          fixer: CODEX,
          answer: (round) =>
            verdictOf(round === 1 ? "[BLOCKER] null deref in parse()\n[MINOR] naming" : "NONE"),
        })

        expect(result.state).toBe("done")
        expect(result.steps.at(-1)).toMatchObject({ status: "done", runs: 2 })
        const fix = specs.find((spec) => spec.title === FIX)
        expect(fix?.botId).toBe(root.botId)
        expect(fix?.prompt).toContain("[BLOCKER] null deref in parse()")
        expect(fix?.prompt).not.toContain("naming")
        expect(fix?.repo?.base).toBe("plan/abc123")
        expect(fix?.review).toBeUndefined()
        const [first, second] = reviewsOf(specs)
        expect(first?.review?.excludeExecutors).toEqual([CLAUDE])
        expect([...(second?.review?.excludeExecutors ?? [])].sort()).toEqual([CLAUDE, CODEX].sort())
        expect(integration.merges).toEqual(["a", FIX])
        expect(integration.prs).toHaveLength(1)
      }).pipe(Effect.provide(DispatchLayer)),
  )

  it.effect("the second review is blocked as needs_human when the fix used the last other executor", () =>
    Effect.gen(function* () {
      const { result, specs } = yield* play([checked("a")], {
        worker: CLAUDE,
        fixer: CODEX,
        answer: (round) =>
          round === 1
            ? verdictOf("[MAJOR] wrong")
            : // The runner finds no executor outside [claude-code, codex].
              {
                ...verdictOf(""),
                kind: "blocked",
                evidence: ["no executor available for tier heavy"],
              },
      })
      expect(result.state).toBe("failed")
      expect(result.steps.at(-1)?.status).toBe("blocked")
      expect(result.steps.at(-1)?.reason).toContain("other than the worker's")
      expect(reviewsOf(specs)[1]?.review?.excludeExecutors).toContain(CODEX)
    }).pipe(Effect.provide(DispatchLayer)),
  )

  it.effect("findings that persist after the fix fail the plan and open no PR", () =>
    Effect.gen(function* () {
      const { result, specs, integration } = yield* play([checked("a")], {
        worker: CLAUDE,
        answer: () => verdictOf("[MAJOR] still wrong"),
      })
      expect(result.state).toBe("failed")
      expect(result.steps.at(-1)).toMatchObject({ status: "failed", runs: 2 })
      expect(result.steps.at(-1)?.reason).toContain("blocking finding")
      expect(reviewsOf(specs)).toHaveLength(2)
      expect(integration.prs).toEqual([])
    }).pipe(Effect.provide(DispatchLayer)),
  )

  it.effect("MINOR findings never block", () =>
    Effect.gen(function* () {
      const { result, specs } = yield* play([checked("a")], {
        worker: CLAUDE,
        answer: () => verdictOf("[MINOR] rename x"),
      })
      expect(result.state).toBe("done")
      expect(reviewsOf(specs)).toHaveLength(1)
    }).pipe(Effect.provide(DispatchLayer)),
  )

  it.effect("an answer that is not a review is not a verdict: the step is blocked for a person", () =>
    Effect.gen(function* () {
      const { result, integration } = yield* play([checked("a")], {
        worker: CLAUDE,
        answer: () => verdictOf("Looks fine to me, ship it."),
      })
      expect(result.state).toBe("failed")
      expect(result.steps.at(-1)?.status).toBe("blocked")
      expect(result.steps.at(-1)?.reason).toContain("needs_human")
      expect(integration.prs).toEqual([])
    }).pipe(Effect.provide(DispatchLayer)),
  )

  it.effect("no executor besides the worker's: the review is blocked as needs_human", () =>
    Effect.gen(function* () {
      const { result } = yield* play([checked("a")], {
        worker: CLAUDE,
        answer: () => ({
          ...verdictOf(""),
          kind: "blocked",
          evidence: ["no executor available for tier heavy"],
        }),
      })
      expect(result.steps.at(-1)?.status).toBe("blocked")
      expect(result.steps.at(-1)?.reason).toContain("other than the worker's")
    }).pipe(Effect.provide(DispatchLayer)),
  )

  it.effect(
    "work steps that recorded no executor leave nothing to keep the reviewer apart from: needs_human",
    () =>
      Effect.gen(function* () {
        const { result, specs } = yield* play([checked("a")], {
          worker: undefined,
          answer: () => verdictOf("NONE"),
        })
        expect(result.steps.at(-1)?.status).toBe("blocked")
        expect(result.steps.at(-1)?.reason).toContain("needs_human")
        expect(reviewsOf(specs)).toHaveLength(0)
      }).pipe(Effect.provide(DispatchLayer)),
  )
})
