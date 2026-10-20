import { it } from "@effect/vitest"
import { Duration, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect } from "vitest"
import {
  type BridgeApi,
  BridgeApiError,
  type EvaluateResult,
  type WaitResult,
} from "../../src/permission-bridge/api.js"
import {
  APPROVAL_TIMEOUT_MS,
  type DecideOptions,
  decidePermission,
  type PermissionRequest,
  WAIT_SLICE_MS,
} from "../../src/permission-bridge/decide.js"

const APPROVAL = "apr_0b9c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d"
const REQUEST: PermissionRequest = {
  tool_name: "Bash",
  input: { command: "git push origin main" },
  tool_use_id: "toolu_1",
}
const OPTIONS: DecideOptions = {
  mode: "inline",
  approvalTimeoutMs: APPROVAL_TIMEOUT_MS,
  waitSliceMs: WAIT_SLICE_MS,
}

const ASK: EvaluateResult = { effect: "ask", approvalId: APPROVAL }

type Wait = WaitResult["status"] | "error"

// Scripted core: evaluate answers come from `evaluations`, each long-poll sleeps its slice (on the test clock) when the
// scripted answer is "pending", like the real route.
const fakeApi = (script: {
  readonly evaluations: ReadonlyArray<EvaluateResult | "error">
  readonly waits?: ReadonlyArray<Wait>
}) => {
  const seen = { evaluations: [] as Array<unknown>, waits: [] as Array<number> }
  let evalIndex = 0
  let waitIndex = 0
  const api: BridgeApi = {
    evaluate: (call) => {
      seen.evaluations.push(call)
      const next = script.evaluations[Math.min(evalIndex, script.evaluations.length - 1)]
      evalIndex += 1
      return next === "error" || next === undefined
        ? Effect.fail(new BridgeApiError({ op: "evaluate", reason: "network error" }))
        : Effect.succeed(next)
    },
    wait: (_id, timeoutMs) => {
      seen.waits.push(timeoutMs)
      const next = script.waits?.[Math.min(waitIndex, (script.waits?.length ?? 1) - 1)] ?? "pending"
      waitIndex += 1
      if (next === "error") return Effect.fail(new BridgeApiError({ op: "wait", reason: "timeout" }))
      return next === "pending"
        ? Effect.as(Effect.sleep(Duration.millis(timeoutMs)), { status: "pending" as const })
        : Effect.succeed({ status: next })
    },
  }
  return { api, seen }
}

describe("decidePermission", () => {
  it.effect("allows at once when the core allows, echoing the original input", () =>
    Effect.gen(function* () {
      const { api, seen } = fakeApi({ evaluations: [{ effect: "allow" }] })
      const verdict = yield* decidePermission(api, REQUEST, OPTIONS)
      expect(verdict).toEqual({ behavior: "allow", updatedInput: REQUEST.input })
      expect(seen.evaluations).toEqual([{ tool: "Bash", input: REQUEST.input }])
      expect(seen.waits).toEqual([])
    }),
  )

  it.effect("denies at once with the policy reason", () =>
    Effect.gen(function* () {
      const { api } = fakeApi({ evaluations: [{ effect: "deny", reason: "force push is blocked" }] })
      expect(yield* decidePermission(api, REQUEST, OPTIONS)).toEqual({
        behavior: "deny",
        message: "force push is blocked",
      })
    }),
  )

  it.effect("ask: waits for the decision, evaluates again so the approval is spent, then allows", () =>
    Effect.gen(function* () {
      const { api, seen } = fakeApi({
        evaluations: [ASK, { effect: "allow", approvalId: APPROVAL }],
        waits: ["approved"],
      })
      const verdict = yield* decidePermission(api, REQUEST, OPTIONS)
      expect(verdict).toMatchObject({ behavior: "allow" })
      expect(seen.evaluations).toHaveLength(2)
      expect(seen.waits).toEqual([WAIT_SLICE_MS])
    }),
  )

  it.effect("keeps long-polling in slices of at most 60 s while the approval is pending", () =>
    Effect.gen(function* () {
      const { api, seen } = fakeApi({
        evaluations: [ASK, { effect: "allow" }],
        waits: ["pending", "pending", "approved"],
      })
      const fiber = yield* Effect.forkChild(decidePermission(api, REQUEST, OPTIONS))
      yield* TestClock.adjust(Duration.millis(2 * WAIT_SLICE_MS))
      const verdict = yield* Fiber.join(fiber)
      expect(verdict).toMatchObject({ behavior: "allow" })
      expect(seen.waits).toEqual([WAIT_SLICE_MS, WAIT_SLICE_MS, WAIT_SLICE_MS])
    }),
  )

  it.effect("denies when the approval is denied or expired", () =>
    Effect.gen(function* () {
      for (const status of ["denied", "expired"] as const) {
        const { api } = fakeApi({ evaluations: [ASK], waits: [status] })
        const verdict = yield* decidePermission(api, REQUEST, OPTIONS)
        expect(verdict.behavior).toBe("deny")
      }
    }),
  )

  it.effect("gives up at the approval timeout, shortening the last slice, and denies", () =>
    Effect.gen(function* () {
      const { api, seen } = fakeApi({ evaluations: [ASK], waits: ["pending"] })
      const options = { ...OPTIONS, approvalTimeoutMs: 150_000 }
      const fiber = yield* Effect.forkChild(decidePermission(api, REQUEST, options))
      yield* TestClock.adjust(Duration.millis(150_000))
      const verdict = yield* Fiber.join(fiber)
      expect(verdict).toEqual({ behavior: "deny", message: "Approval expired without an answer." })
      expect(seen.waits).toEqual([60_000, 60_000, 30_000])
    }),
  )

  it.effect("approved, but the second evaluate asks again: deny at once, no new wait", () =>
    Effect.gen(function* () {
      const { api, seen } = fakeApi({ evaluations: [ASK], waits: ["approved"] })
      const verdict = yield* decidePermission(api, REQUEST, OPTIONS)
      expect(verdict).toEqual({ behavior: "deny", message: "The approval no longer covers this call." })
      expect(seen.evaluations).toHaveLength(2)
      expect(seen.waits).toEqual([WAIT_SLICE_MS])
    }),
  )

  it.effect("the deadline runs from the start of the decision, not from the ask", () =>
    Effect.gen(function* () {
      const { api, seen } = fakeApi({ evaluations: [ASK], waits: ["pending"] })
      // The evaluate itself takes 40 s on the test clock; the 100 s budget leaves 60 s for the wait.
      const slow: BridgeApi = {
        ...api,
        evaluate: (call) => Effect.andThen(Effect.sleep(Duration.millis(40_000)), api.evaluate(call)),
      }
      const fiber = yield* Effect.forkChild(
        decidePermission(slow, REQUEST, { ...OPTIONS, approvalTimeoutMs: 100_000 }),
      )
      yield* TestClock.adjust(Duration.millis(100_000))
      const verdict = yield* Fiber.join(fiber)
      expect(verdict).toEqual({ behavior: "deny", message: "Approval expired without an answer." })
      expect(seen.waits).toEqual([60_000])
    }),
  )

  it.effect("resume mode: an ask denies at once with the paused message and never waits", () =>
    Effect.gen(function* () {
      const { api, seen } = fakeApi({ evaluations: [ASK] })
      const verdict = yield* decidePermission(api, REQUEST, { ...OPTIONS, mode: "resume" })
      expect(verdict).toMatchObject({ behavior: "deny" })
      expect(verdict.behavior === "deny" && verdict.message).toContain("will resume")
      expect(seen.waits).toEqual([])
    }),
  )

  it.effect("fails closed when the core is unreachable", () =>
    Effect.gen(function* () {
      const { api } = fakeApi({ evaluations: ["error"] })
      expect((yield* decidePermission(api, REQUEST, OPTIONS)).behavior).toBe("deny")
    }),
  )

  it.effect("retries a failing long-poll, then fails closed after three errors in a row", () =>
    Effect.gen(function* () {
      const { api, seen } = fakeApi({ evaluations: [ASK], waits: ["error"] })
      const fiber = yield* Effect.forkChild(decidePermission(api, REQUEST, OPTIONS))
      yield* TestClock.adjust(Duration.millis(5_000))
      const verdict = yield* Fiber.join(fiber)
      expect(verdict.behavior).toBe("deny")
      expect(seen.waits).toHaveLength(3)
    }),
  )
})
