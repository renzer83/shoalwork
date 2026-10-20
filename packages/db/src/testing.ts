import { randomUUID } from "node:crypto"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { makeDbLayer } from "./client.js"
import { runMigrations } from "./migrator.js"

const removeDbFiles = (path: string): void => {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${path}${suffix}`, { force: true })
  }
}

// One database file per test; removed when the layer's scope closes.
const tempDbPath = Effect.acquireRelease(
  Effect.sync(() => join(tmpdir(), `shoalwork-test-${randomUUID()}.db`)),
  (path) => Effect.sync(() => removeDbFiles(path)),
)

// Fresh database with no migrations applied.
export const withRawTempDb = () => Layer.unwrap(Effect.map(tempDbPath, (path) => makeDbLayer(path)))

// Fresh database with migrations applied.
export const withTempDb = () => Layer.provideMerge(Layer.effectDiscard(runMigrations), withRawTempDb())
