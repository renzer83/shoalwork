import { Data, Effect, Schema } from "effect"

// Row shape of memory_items (snake_case, as stored). Decoded at the db boundary.
export const MemoryScope = Schema.Literals(["bot", "pod", "global"])
export type MemoryScope = typeof MemoryScope.Type

export const MemoryKind = Schema.Literals(["working", "episodic", "semantic", "procedural"])
export type MemoryKind = typeof MemoryKind.Type

export const MemoryRow = Schema.Struct({
  id: Schema.String,
  scope: MemoryScope,
  owner_id: Schema.String,
  kind: MemoryKind,
  content: Schema.String,
  source: Schema.String,
  confidence: Schema.Number,
  created_at: Schema.String,
  superseded_by: Schema.NullOr(Schema.String),
  tombstone: Schema.Literals([0, 1]),
  embedding: Schema.NullOr(Schema.instanceOf(Uint8Array)),
})
export type MemoryRow = typeof MemoryRow.Type

export const EMBED_DIMS = 1024
const BYTES_PER_FLOAT32 = 4

// Embedding shape does not match what the store or the model promised.
export class EmbeddingShapeError extends Data.TaggedError("EmbeddingShapeError")<{
  readonly detail: string
}> {}

// float32 little-endian, explicit through DataView so the file format does not depend on the host CPU.
export const encodeEmbedding = (
  vector: ReadonlyArray<number>,
): Effect.Effect<Uint8Array, EmbeddingShapeError> => {
  if (vector.length !== EMBED_DIMS) {
    return Effect.fail(
      new EmbeddingShapeError({ detail: `expected ${EMBED_DIMS} dims, got ${vector.length}` }),
    )
  }
  const bytes = new Uint8Array(EMBED_DIMS * BYTES_PER_FLOAT32)
  const view = new DataView(bytes.buffer)
  vector.forEach((value, index) => {
    view.setFloat32(index * BYTES_PER_FLOAT32, value, true)
  })
  return Effect.succeed(bytes)
}

export const decodeEmbedding = (bytes: Uint8Array): Effect.Effect<Float32Array, EmbeddingShapeError> => {
  const expected = EMBED_DIMS * BYTES_PER_FLOAT32
  if (bytes.byteLength !== expected) {
    return Effect.fail(
      new EmbeddingShapeError({ detail: `expected ${expected} bytes, got ${bytes.byteLength}` }),
    )
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const vector = new Float32Array(EMBED_DIMS)
  for (let index = 0; index < EMBED_DIMS; index++) {
    vector[index] = view.getFloat32(index * BYTES_PER_FLOAT32, true)
  }
  return Effect.succeed(vector)
}
