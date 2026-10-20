import { Beacon, BeaconLive } from "@shoalwork/beacon"
import { Conflict } from "@shoalwork/contracts"
import { withTempDb } from "@shoalwork/db/testing"
import { Effect, Layer } from "effect"
import { Embedder, type EmbedderShape, EmbedderTest, testVector } from "../src/embedder.js"
import { ReefLive, type ReefOptions } from "../src/reef.js"
import { EMBED_DIMS } from "../src/rows.js"

export const axis = (index: number): Array<number> =>
  Array.from({ length: EMBED_DIMS }, (_, i) => (i === index ? 1 : 0))

// Unit vector whose cosine with axis(0) is exactly `cos`; the rest of the mass sits on axis(1).
export const atCosine = (cos: number): Array<number> =>
  Array.from({ length: EMBED_DIMS }, (_, i) => (i === 0 ? cos : i === 1 ? Math.sqrt(1 - cos * cos) : 0))

// Embedder with hand-placed vectors for chosen texts (exact match, case-insensitive); anything else falls back
// to the deterministic hash vector, which is close to orthogonal to every placed vector.
export const fixtureEmbedder = (
  placed: Readonly<Record<string, ReadonlyArray<number>>>,
): Layer.Layer<Embedder> => {
  const lookup = new Map(Object.entries(placed).map(([text, vector]) => [text.toLowerCase(), vector]))
  const shape: EmbedderShape = {
    dims: EMBED_DIMS,
    embed: (texts) => Effect.succeed(texts.map((text) => lookup.get(text.toLowerCase()) ?? testVector(text))),
  }
  return Layer.succeed(Embedder, shape)
}

// Flip `failAppend` to make every Beacon append fail (reads keep working). Tests reset it when done.
const switches = { failAppend: false }
export const setFailAppend = (value: boolean): void => {
  switches.failAppend = value
}

const flakyBeacon = Layer.effect(
  Beacon,
  Effect.gen(function* () {
    const real = yield* Beacon
    return {
      ...real,
      append: (...args: Parameters<typeof real.append>) =>
        switches.failAppend
          ? Effect.fail(new Conflict({ streamId: args[0].streamId, expectedVersion: 0 }))
          : real.append(...args),
    }
  }),
).pipe(Layer.provide(BeaconLive))

// Reef over a fresh migrated database, a Beacon over the real SQL one and the given embedder.
export const reefStack = (embedder: Layer.Layer<Embedder> = EmbedderTest, options: ReefOptions = {}) =>
  ReefLive(options).pipe(
    Layer.provideMerge(flakyBeacon),
    Layer.provideMerge(embedder),
    Layer.provideMerge(withTempDb()),
  )
