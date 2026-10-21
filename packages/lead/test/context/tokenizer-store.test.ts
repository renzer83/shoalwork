import { it } from "@effect/vitest"
import { withTempDb } from "@shoalwork/db/testing"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { loadCalibration, saveCalibration } from "../../src/context/tokenizer-calibration.js"

const AT = "2026-10-21T00:00:00.000Z"

describe("tokenizer calibration store", () => {
  it.effect("saves a factor and reads it back, the newer row replacing the older one of the same key", () =>
    Effect.gen(function* () {
      yield* saveCalibration({ executor: "claude-code", lang: "code", factor: 3.2, n: 0 }, AT)
      yield* saveCalibration(
        { executor: "claude-code", lang: "code", factor: 3.1, n: 2 },
        "2026-10-21T01:00:00.000Z",
      )
      yield* saveCalibration({ executor: "codex", lang: "prose_en", factor: 4, n: 1 }, AT)
      const rows = yield* loadCalibration
      expect(rows).toHaveLength(2)
      expect(rows).toContainEqual({ executor: "claude-code", lang: "code", factor: 3.1, n: 2 })
      expect(rows).toContainEqual({ executor: "codex", lang: "prose_en", factor: 4, n: 1 })
    }).pipe(Effect.provide(withTempDb())),
  )

  it.effect("an empty table loads as no entries", () =>
    Effect.gen(function* () {
      expect(yield* loadCalibration).toEqual([])
    }).pipe(Effect.provide(withTempDb())),
  )
})
