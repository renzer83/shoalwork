import { resolve } from "node:path"
import type { SchemaViolation } from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import { type Flags, type Settings, UsageError } from "../args.js"
import { ApiClient, type HttpError } from "../client.js"

// Mirrors the 200 body of POST /memory/import (ImportReport in packages/reef/src/import.ts).
export const MemoryImportReport = Schema.Struct({
  files: Schema.Int,
  chunks: Schema.Int,
  created: Schema.Int,
  superseded: Schema.Int,
  unchanged: Schema.Int,
  forgotten: Schema.Int,
  skipped: Schema.Array(Schema.Struct({ path: Schema.String, reason: Schema.String })),
  rejected: Schema.Array(Schema.String),
})
export type MemoryImportReport = typeof MemoryImportReport.Type

const KINDS: ReadonlyArray<string> = ["semantic", "procedural"]

const required = (flags: Flags, name: string): Effect.Effect<string, UsageError> => {
  const value = flags[name]
  return value === undefined || value === ""
    ? Effect.fail(new UsageError({ message: `missing --${name}` }))
    : Effect.succeed(value)
}

// "global" or "bot:<name>"; the core checks the rest. The directory is made absolute here: the core runs elsewhere.
export const memoryImport = (
  settings: Settings,
  flags: Flags,
): Effect.Effect<MemoryImportReport, UsageError | HttpError | SchemaViolation> =>
  Effect.gen(function* () {
    const dir = yield* required(flags, "dir")
    const scope = yield* required(flags, "scope")
    const kind = yield* required(flags, "kind")
    const source = yield* required(flags, "source")
    if (scope !== "global" && !/^bot:.+$/.test(scope)) {
      return yield* Effect.fail(new UsageError({ message: "--scope must be global or bot:<name>" }))
    }
    if (!KINDS.includes(kind)) {
      return yield* Effect.fail(new UsageError({ message: "--kind must be semantic or procedural" }))
    }
    return yield* new ApiClient(settings.url, settings.token).post(
      "/memory/import",
      { dir: resolve(process.cwd(), dir), scope, kind, source },
      MemoryImportReport,
    )
  })
