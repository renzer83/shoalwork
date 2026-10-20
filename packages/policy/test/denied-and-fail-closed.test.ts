import { it } from "@effect/vitest"
import { Beacon } from "@shoalwork/beacon"
import { streamIds } from "@shoalwork/contracts"
import { Effect, Stream } from "effect"
import { describe, expect } from "vitest"
import { Policy } from "../src/index.js"
import { BOT, baseLayer, bash, DEFAULT_YAML, evaluate, policyWith } from "./support.js"

describe("policy.denied event", () => {
  it.effect("is recorded on the bot stream for a deny", () =>
    Effect.gen(function* () {
      const policy = yield* Policy
      yield* policy.evaluate(BOT, bash("rm -rf /"))
      const beacon = yield* Beacon
      const events = yield* Stream.runCollect(beacon.readAll(0, ["policy.denied"]))
      expect(events).toHaveLength(1)
      const [event] = events
      expect(event?.streamId).toBe(streamIds.bot(BOT))
      expect(event?.payload).toMatchObject({ botId: BOT, tool: "Bash" })
      const payload = event?.payload as { rule: string } | undefined
      expect(payload?.rule).toContain("deny")
    }).pipe(Effect.provide(baseLayer)),
  )

  it.effect("is not recorded for ask or allow", () =>
    Effect.gen(function* () {
      const policy = yield* Policy
      yield* policy.evaluate(BOT, bash("git push origin main"))
      yield* policy.evaluate(BOT, bash("git status"))
      const beacon = yield* Beacon
      expect(yield* Stream.runCollect(beacon.readAll(0, ["policy.denied"]))).toHaveLength(0)
    }).pipe(Effect.provide(baseLayer)),
  )
})

describe("fail closed", () => {
  it.effect("falls back to the default policy when the bot has no policy name", () =>
    Effect.gen(function* () {
      const decision = yield* evaluate(bash("git status"))
      expect(decision.effect).toBe("allow")
    }).pipe(Effect.provide(policyWith({ default: DEFAULT_YAML }, () => undefined))),
  )

  it.effect("asks when the policy name is unknown", () =>
    Effect.gen(function* () {
      const decision = yield* evaluate(bash("git status"))
      expect(decision.effect).toBe("ask")
    }).pipe(Effect.provide(policyWith({ default: DEFAULT_YAML }, () => "missing"))),
  )

  it.effect("asks when policyOf throws", () =>
    Effect.gen(function* () {
      const decision = yield* evaluate(bash("git status"))
      expect(decision.effect).toBe("ask")
    }).pipe(
      Effect.provide(
        policyWith({ default: DEFAULT_YAML }, () => {
          throw new Error("lookup failed")
        }),
      ),
    ),
  )

  it.effect("asks for a Bash call without a command string", () =>
    Effect.gen(function* () {
      const decision = yield* evaluate({ tool: "Bash", input: { cmd: "git status" } })
      expect(decision.effect).toBe("ask")
    }).pipe(Effect.provide(baseLayer)),
  )
})

describe("reload", () => {
  it.effect("keeps the rules when the sources still compile", () =>
    Effect.gen(function* () {
      const policy = yield* Policy
      yield* policy.reload()
      const decision = yield* evaluate(bash("rm -rf /"))
      expect(decision.effect).toBe("deny")
    }).pipe(Effect.provide(baseLayer)),
  )
})
