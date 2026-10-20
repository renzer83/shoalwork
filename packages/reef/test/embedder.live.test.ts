import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { cosine, Embedder, EmbedderOllamaLive } from "../src/embedder.js"

// Real Ollama with bge-m3 pulled: runs only with LIVE=1. OLLAMA_URL defaults to localhost.
describe.skipIf(process.env.LIVE !== "1")("ollama embeddings live", () => {
  it.live("embeds two texts with the real bge-m3 model", () =>
    Effect.gen(function* () {
      const embedder = yield* Embedder
      const vectors = yield* embedder.embed(["a", "b"])
      expect(vectors).toHaveLength(2)
      expect(vectors[0]).toHaveLength(1024)
      expect(vectors[1]).toHaveLength(1024)
      expect(cosine(vectors[0] ?? [], vectors[0] ?? [])).toBeCloseTo(1, 5)
    }).pipe(
      Effect.provide(EmbedderOllamaLive({ baseUrl: process.env.OLLAMA_URL ?? "http://localhost:11434" })),
    ),
  )
})
