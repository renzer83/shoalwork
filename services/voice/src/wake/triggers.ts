import type { VoiceError } from "@shoalwork/contracts"
import { Context, Effect, Layer, Option, Queue, Schema, Stream } from "effect"
import type { WakeWordShape } from "./openwakeword.js"

// What the VOICE_TRIGGER setting picks: wake word, hotkey (POST /voice/wake), push-to-talk (POST /voice/ptt).
export const TriggerMode = Schema.Literals(["wake", "hotkey", "ptt", "wake+hotkey"])
export type TriggerMode = typeof TriggerMode.Type

export const TriggerSource = Schema.Literals(["wake", "hotkey", "ptt_down", "ptt_up"])
export type TriggerSource = typeof TriggerSource.Type

// The sources the HTTP routes can feed. A route whose source the mode leaves out answers 409.
export type ManualSource = "hotkey" | "ptt_down" | "ptt_up"

// Supervisor-style notification for a wake word detection (02-architecture §3 lists the Beacon events).
export const WakeEvent = Schema.Struct({
  type: Schema.Literal("voice.wake"),
  name: Schema.String,
  score: Schema.Number,
  t: Schema.Number,
})
export type WakeEvent = typeof WakeEvent.Type

export type ModeSources = {
  readonly wake: boolean
  readonly hotkey: boolean
  readonly ptt: boolean
}

// `ptt` has no wake word: push-to-talk is the only way in. `wake+hotkey` runs both.
export const modeSources = (mode: TriggerMode): ModeSources => ({
  wake: mode === "wake" || mode === "wake+hotkey",
  hotkey: mode === "hotkey" || mode === "wake+hotkey",
  ptt: mode === "ptt",
})

export type TriggerShape = {
  // One consumer. Wake detections, hotkeys and push-to-talk edges, in arrival order.
  readonly events: () => Stream.Stream<TriggerSource, VoiceError>
  // false when the mode does not enable the source; nothing is queued then.
  readonly accept: (source: ManualSource) => Effect.Effect<boolean>
}

export class Trigger extends Context.Service<Trigger, TriggerShape>()("@shoalwork/Trigger") {}

// The wake word stream is only subscribed when the mode enables it, so the microphone stays closed otherwise.
export const makeTrigger = (
  mode: TriggerMode,
  wake: Option.Option<WakeWordShape>,
): Effect.Effect<TriggerShape> =>
  Effect.gen(function* () {
    const enabled = modeSources(mode)
    const queue = yield* Queue.unbounded<TriggerSource>()

    const events = (): Stream.Stream<TriggerSource, VoiceError> => {
      const fromWake: Stream.Stream<TriggerSource, VoiceError> =
        enabled.wake && Option.isSome(wake)
          ? wake.value.detections().pipe(
              Stream.tap((detection) =>
                Effect.logInfo(`voice.wake name=${detection.name} score=${detection.score} t=${detection.t}`),
              ),
              Stream.map((): TriggerSource => "wake"),
            )
          : Stream.empty
      return Stream.merge(fromWake, Stream.fromQueue(queue))
    }

    const accept = (source: ManualSource): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const allowed = source === "hotkey" ? enabled.hotkey : enabled.ptt
        if (!allowed) return false
        yield* Queue.offer(queue, source)
        yield* Effect.logInfo(`voice.trigger source=${source}`)
        return true
      })

    return { events, accept }
  })

export const TriggerLive = (mode: TriggerMode, wake: Option.Option<WakeWordShape>): Layer.Layer<Trigger> =>
  Layer.effect(Trigger, makeTrigger(mode, wake))
