import { MemoryRow } from "@shoalwork/reef"
import { Effect, Schema, Struct } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"

// The memory row without the embedding blob, the shape the API reads.
const ListRow = MemoryRow.mapFields(Struct.omit(["embedding"]))

// The current items of one Bot (not forgotten, not superseded), newest first. The Reef only searches, so the table is
// read directly.
export const listCurrentItems = (bot: string, k: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const rows = yield* sql`SELECT * FROM memory_items WHERE scope = 'bot' AND owner_id = ${bot}
      AND tombstone = 0 AND superseded_by IS NULL ORDER BY created_at DESC LIMIT ${k}`
    return yield* Schema.decodeUnknownEffect(Schema.Array(ListRow))(rows)
  }) satisfies Effect.Effect<ReadonlyArray<typeof ListRow.Type>, SqlError | Schema.SchemaError, SqlClient>
