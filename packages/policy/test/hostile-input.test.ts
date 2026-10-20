import { it } from "@effect/vitest"
import { BeaconTest } from "@shoalwork/beacon"
import { Effect, Layer } from "effect"
import { describe, expect } from "vitest"
import { makePolicyTest, Policy } from "../src/index.js"
import { globMatch } from "../src/match.js"
import { BOT, baseLayer, bash, DEFAULT_YAML, policyWith } from "./support.js"

// Hostile shapes: long words, separators, nested substitution, backticks, an unterminated quote.
const hostileCommands = (size: number): ReadonlyArray<string> => [
  `git status ${"a ".repeat(size / 2)}`,
  ";".repeat(size),
  "$(".repeat(size / 2),
  `echo ${"`".repeat(size)}`,
  `"${"x".repeat(size)}`,
]

// No test here measures time: wall-clock limits flake under parallel load. These tests prove each hostile shape is
// decided (no throw, no hang) within the vitest timeout. Linear cost is guaranteed by the input cap in the policy.
const GLOB_PATTERN = "*a*a*a*a*a*a*a*a*b"
const HOSTILE_TIMEOUT_MS = 30_000

describe("hostile input is decided", () => {
  it.effect(
    "decides every hostile shape up to the input cap",
    () =>
      Effect.gen(function* () {
        const policy = yield* Policy
        for (const size of [3_000, 12_000, 15_000]) {
          for (const command of hostileCommands(size)) {
            const decision = yield* policy.evaluate(BOT, bash(command))
            expect(["allow", "ask", "deny"]).toContain(decision.effect)
          }
        }
      }).pipe(Effect.provide(baseLayer)),
    HOSTILE_TIMEOUT_MS,
  )

  it.effect(
    "matches a resource against a pattern full of wildcards without failing",
    () =>
      Effect.gen(function* () {
        expect(globMatch(GLOB_PATTERN, "a".repeat(100_000), true)).toBe(false)
        const policy = yield* Policy
        const decision = yield* policy.evaluate(BOT, {
          tool: "Read",
          input: {},
          resource: "a".repeat(15_000),
        })
        expect(decision.effect).toBe("allow")
      }).pipe(
        Effect.provide(
          policyWith(
            {
              default: DEFAULT_YAML,
              dev: `rules:\n  - { bot: "*", tool: "Read(*a*a*a*a*b)", effect: deny }\n`,
            },
            () => "dev",
          ),
        ),
      ),
    HOSTILE_TIMEOUT_MS,
  )
})

describe("input size cap", () => {
  // Above the cap the answer is ask, whatever the content: no lexing, no rule lookup. Checked by the decision itself.
  it.effect(
    "asks at once for 200 KB commands without parsing them",
    () =>
      Effect.gen(function* () {
        const policy = yield* Policy
        for (const command of hostileCommands(200_000)) {
          const decision = yield* policy.evaluate(BOT, bash(command))
          expect(decision).toEqual({ effect: "ask", risk: "irreversible" })
        }
      }).pipe(Effect.provide(baseLayer)),
    30_000,
  )

  it.effect("asks at once for an oversized resource or path field", () =>
    Effect.gen(function* () {
      const policy = yield* Policy
      const big = "a".repeat(200_000)
      const readPath = yield* policy.evaluate(BOT, { tool: "Read", input: { file_path: big } })
      const editPath = yield* policy.evaluate(BOT, { tool: "Edit", input: { file_path: `src/${big}.ts` } })
      const resource = yield* policy.evaluate(BOT, { tool: "Read", input: {}, resource: big })
      expect(readPath).toEqual({ effect: "ask", risk: "irreversible" })
      expect(editPath).toEqual({ effect: "ask", risk: "irreversible" })
      expect(resource).toEqual({ effect: "ask", risk: "irreversible" })
    }).pipe(Effect.provide(baseLayer)),
  )

  it.effect("keeps deny for inputs that fit under the cap", () =>
    Effect.gen(function* () {
      const policy = yield* Policy
      const small = yield* policy.evaluate(BOT, { tool: "Read", input: { file_path: "config/.secret" } })
      const large = yield* policy.evaluate(BOT, {
        tool: "Read",
        input: { file_path: `${"a/".repeat(10_000)}.secret` },
      })
      expect(small.effect).toBe("deny")
      expect(large).toEqual({ effect: "ask", risk: "irreversible" })
    }).pipe(
      Effect.provide(
        policyWith(
          {
            default: DEFAULT_YAML,
            dev: `rules:\n  - { bot: "*", tool: "Read(**/*.secret)", effect: deny }\n`,
          },
          () => "dev",
        ),
      ),
    ),
  )

  it.effect("uses the cap given to the layer", () =>
    Effect.gen(function* () {
      const policy = yield* Policy
      const plain = yield* policy.evaluate(BOT, bash("git status"))
      const padded = yield* policy.evaluate(BOT, bash(`git status ${" ".repeat(200)}`))
      expect(plain.effect).toBe("allow")
      expect(padded).toEqual({ effect: "ask", risk: "irreversible" })
    }).pipe(
      Effect.provide(
        makePolicyTest({
          sources: { default: DEFAULT_YAML },
          policyOf: () => "default",
          maxInputBytes: 100,
        }).pipe(Layer.provideMerge(BeaconTest)),
      ),
    ),
  )
})
