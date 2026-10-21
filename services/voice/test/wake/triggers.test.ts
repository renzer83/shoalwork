import { it } from "@effect/vitest"
import { Effect, Option, Schema, Stream } from "effect"
import { describe, expect } from "vitest"
import type { WakeWordShape } from "../../src/wake/openwakeword.js"
import { makeTrigger, modeSources, type TriggerMode, WakeEvent } from "../../src/wake/triggers.js"

// A wake word that never touches the microphone: it only counts subscriptions and yields one detection per run.
const fakeWake = (): WakeWordShape & { readonly runs: () => number } => {
  let runs = 0
  return {
    runs: () => runs,
    detections: () => {
      runs += 1
      return Stream.fromIterable([{ name: "hey_test", score: 0.93, t: 0 }])
    },
  }
}

describe("trigger modes", () => {
  it("enable exactly the sources of each VOICE_TRIGGER value", () => {
    const table: Record<TriggerMode, { wake: boolean; hotkey: boolean; ptt: boolean }> = {
      wake: { wake: true, hotkey: false, ptt: false },
      hotkey: { wake: false, hotkey: true, ptt: false },
      ptt: { wake: false, hotkey: false, ptt: true },
      "wake+hotkey": { wake: true, hotkey: true, ptt: false },
    }

    for (const mode of Object.keys(table) as TriggerMode[]) expect(modeSources(mode)).toEqual(table[mode])
  })
})

describe("Trigger", () => {
  it.live("unifies the wake word and the hotkey route in arrival order of the sources", () =>
    Effect.gen(function* () {
      const trigger = yield* makeTrigger("wake+hotkey", Option.some(fakeWake()))

      expect(yield* trigger.accept("hotkey")).toBe(true)
      const seen = yield* Stream.runCollect(trigger.events().pipe(Stream.take(2)))

      expect([...seen].sort()).toEqual(["hotkey", "wake"])
    }),
  )

  it.live("opens and closes push-to-talk with the ptt_down and ptt_up edges, in order", () =>
    Effect.gen(function* () {
      const trigger = yield* makeTrigger("ptt", Option.none())

      expect(yield* trigger.accept("ptt_down")).toBe(true)
      expect(yield* trigger.accept("ptt_up")).toBe(true)
      const seen = yield* Stream.runCollect(trigger.events().pipe(Stream.take(2)))

      expect(seen).toEqual(["ptt_down", "ptt_up"])
    }),
  )

  it.live("refuses sources the mode leaves out and queues nothing for them", () =>
    Effect.gen(function* () {
      const trigger = yield* makeTrigger("hotkey", Option.none())

      expect(yield* trigger.accept("ptt_down")).toBe(false)
      expect(yield* trigger.accept("hotkey")).toBe(true)
      const seen = yield* Stream.runCollect(trigger.events().pipe(Stream.take(1)))

      expect(seen).toEqual(["hotkey"])
    }),
  )

  it.live("never subscribes the wake word, so the microphone stays closed, when the mode has no wake", () =>
    Effect.gen(function* () {
      const wake = fakeWake()
      const trigger = yield* makeTrigger("ptt", Option.some(wake))

      yield* trigger.accept("ptt_down")
      yield* Stream.runCollect(trigger.events().pipe(Stream.take(1)))

      expect(wake.runs()).toBe(0)
    }),
  )
})

describe("WakeEvent", () => {
  it("round-trips the voice.wake event and rejects other types", () => {
    const decode = Schema.decodeUnknownSync(WakeEvent)
    const encode = Schema.encodeSync(WakeEvent)
    const event = { type: "voice.wake" as const, name: "hey_test", score: 0.93, t: 160 }

    expect(decode(encode(event))).toEqual(event)
    expect(() => decode({ ...event, type: "voice.sleep" })).toThrow()
    expect(() => decode({ type: "voice.wake", name: "hey_test", score: 0.93 })).toThrow()
  })
})
