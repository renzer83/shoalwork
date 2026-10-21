import { it } from "@effect/vitest"
import { Effect, Exit, Schema } from "effect"
import { describe, expect } from "vitest"
import { EventPayloads, GitSha, ReplayOverrides } from "../src/events/index.js"

const TASK = "task_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
const OTHER = "task_1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"
const SHA = "0123456789abcdef0123456789abcdef01234567"

describe("replay payloads (T-122)", () => {
  it.effect("round-trips replay.created", () =>
    Effect.gen(function* () {
      const raw = {
        replayId: "rpl_1",
        replayOf: TASK,
        taskId: OTHER,
        overrides: { executor: "codex", tier: "heavy", model: "gpt-5" },
        baseSha: SHA,
        contextFrozen: false,
      }
      const decoded = yield* Schema.decodeUnknownEffect(EventPayloads["replay.created"])(raw)
      expect(yield* Schema.encodeEffect(EventPayloads["replay.created"])(decoded)).toEqual(raw)
    }),
  )

  it.effect("rejects a model name that could pass as an option", () =>
    Effect.gen(function* () {
      for (const model of ["--dangerously", "-x", "a b", "", "x;rm"]) {
        const exit = yield* Effect.exit(Schema.decodeUnknownEffect(ReplayOverrides)({ model }))
        expect(Exit.isFailure(exit)).toBe(true)
      }
    }),
  )

  it.effect("rejects a base that is not a commit hash", () =>
    Effect.gen(function* () {
      for (const sha of ["main", "--orphan", "abc", `${SHA}x`]) {
        expect(Exit.isFailure(yield* Effect.exit(Schema.decodeUnknownEffect(GitSha)(sha)))).toBe(true)
      }
    }),
  )

  it.effect("decodes executor.started with and without baseSha", () =>
    Effect.gen(function* () {
      const base = {
        taskId: TASK,
        botId: "bot_3f2a9c1e-7b4d-4e8a-9f10-2c6d5e8b7a41",
        executor: "claude-code",
        model: "sonnet",
        cwd: "/work",
      }
      const schema = EventPayloads["executor.started"]
      expect((yield* Schema.decodeUnknownEffect(schema)(base)).baseSha).toBeUndefined()
      expect((yield* Schema.decodeUnknownEffect(schema)({ ...base, baseSha: SHA })).baseSha).toBe(SHA)
    }),
  )
})
