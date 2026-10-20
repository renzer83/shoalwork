import { join } from "node:path"
import { it } from "@effect/vitest"
import { TankError } from "@shoalwork/contracts"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { TankLocalLive } from "../src/local.js"
import { Tank } from "../src/tank.js"
import { gitEnv, makeBot, stepId, tempDir } from "./helpers.js"

const root = tempDir()
const tankRoot = join(root, "tanks")
const baseEnv = { ...gitEnv(), PATH: process.env.PATH }

// Prepares a repo-less step; the Tank-level extraEnv and the step's own extraEnv are both optional.
const prepareWith = (
  extraEnv: Readonly<Record<string, string>> | undefined,
  stepExtraEnv: Readonly<Record<string, string>> | undefined,
  name: string,
) =>
  Effect.gen(function* () {
    const tank = yield* Tank
    return yield* tank.prepare(makeBot(name), {
      stepId: stepId(),
      ...(stepExtraEnv === undefined ? {} : { extraEnv: stepExtraEnv }),
    })
  }).pipe(
    Effect.provide(
      TankLocalLive({ root: tankRoot, baseEnv, ...(extraEnv === undefined ? {} : { extraEnv }) }),
    ),
  )

describe("prepare with a per-execution extraEnv", () => {
  it.live("passes the step's SHOALWORK_ env to the Bot process and keeps the step's keys apart", () =>
    Effect.gen(function* () {
      const ctx = yield* prepareWith(
        { ANTHROPIC_API_KEY: "must-not-pass" },
        { SHOALWORK_API_TOKEN: "mcp_test-token" },
        "stepenv",
      )
      expect(ctx.env.SHOALWORK_API_TOKEN).toBe("mcp_test-token")
      expect(ctx.stepEnv).toEqual({ SHOALWORK_API_TOKEN: "mcp_test-token" })
      expect(ctx.env.ANTHROPIC_API_KEY).toBeUndefined()
    }),
  )

  it.live("refuses a step key outside SHOALWORK_ (HOME, ANTHROPIC_API_KEY, anything else)", () =>
    Effect.gen(function* () {
      for (const key of ["HOME", "ANTHROPIC_API_KEY", "shoalwork_token", "SHOALWORK-X"]) {
        const error = yield* Effect.flip(prepareWith(undefined, { [key]: "x" }, `stepbad${key.length}`))
        expect(error).toBeInstanceOf(TankError)
      }
    }),
  )

  it.live("lets the step's env override the Tank-level extraEnv for the same SHOALWORK_ key", () =>
    Effect.gen(function* () {
      const ctx = yield* prepareWith(
        { SHOALWORK_SHARED: "tank" },
        { SHOALWORK_SHARED: "step" },
        "stepoverride",
      )
      expect(ctx.env.SHOALWORK_SHARED).toBe("step")
    }),
  )

  it.live("without a step env, no token reaches the Bot process", () =>
    Effect.gen(function* () {
      const ctx = yield* prepareWith(undefined, undefined, "nostepenv")
      expect(ctx.env.SHOALWORK_API_TOKEN).toBeUndefined()
      expect(ctx.stepEnv).toEqual({})
    }),
  )
})
