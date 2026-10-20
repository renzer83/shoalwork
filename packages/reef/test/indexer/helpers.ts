import { withTempDb } from "@shoalwork/db/testing"
import { Effect, Layer } from "effect"
import { Embedder, EmbedderTest, EmbedError, testVector } from "../../src/embedder.js"
import { IndexerLive, type IndexerOptions } from "../../src/indexer/indexer.js"
import { EMBED_DIMS } from "../../src/rows.js"
import { createFixtureRepo, type FixtureRepo } from "../fixtures/repo/files.js"

export const withFixtureRepo = <A, E, R>(
  use: (repo: FixtureRepo) => Effect.Effect<A, E, R>,
  extra: Readonly<Record<string, string>> = {},
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => createFixtureRepo(extra)),
    use,
    (repo) => Effect.sync(repo.cleanup),
  )

export interface CountingEmbedder {
  readonly layer: Layer.Layer<Embedder>
  // Number of texts in each embed() call, in order.
  readonly calls: Array<number>
  readonly texts: Array<string>
}

export const countingEmbedder = (): CountingEmbedder => {
  const calls: Array<number> = []
  const texts: Array<string> = []
  const layer = Layer.succeed(Embedder, {
    dims: EMBED_DIMS,
    embed: (input) =>
      Effect.sync(() => {
        calls.push(input.length)
        texts.push(...input)
        return input.map(testVector)
      }),
  })
  return { layer, calls, texts }
}

export const failingEmbedder: Layer.Layer<Embedder> = Layer.succeed(Embedder, {
  dims: EMBED_DIMS,
  embed: () => Effect.fail(new EmbedError({ reason: "transport", detail: "down" })),
})

// Indexer + SqlClient on a fresh migrated database.
export const indexerEnv = (embedder: Layer.Layer<Embedder> = EmbedderTest, options: IndexerOptions = {}) =>
  Layer.provideMerge(IndexerLive(options).pipe(Layer.provide(embedder)), withTempDb())

// Fails any batch that contains `needle`; everything else gets deterministic vectors.
export const selectiveEmbedder = (needle: string): Layer.Layer<Embedder> =>
  Layer.succeed(Embedder, {
    dims: EMBED_DIMS,
    embed: (input) =>
      input.some((text) => text.includes(needle))
        ? Effect.fail(new EmbedError({ reason: "http", status: 500, detail: "boom" }))
        : Effect.succeed(input.map(testVector)),
  })
