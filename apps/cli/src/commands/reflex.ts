import { writeFile } from "node:fs/promises"
import { Effect } from "effect"
import { type Flags, type Settings, UsageError } from "../args.js"
import { ApiClient, type HttpError } from "../client.js"

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

// Downloads the Reflex dataset (JSONL, one decision per line) and writes it to --out.
export const reflexExport = (
  settings: Settings,
  flags: Flags,
): Effect.Effect<{ readonly out: string; readonly lines: number }, UsageError | HttpError> =>
  Effect.gen(function* () {
    const out = flags.out
    if (out === undefined || out === "") {
      return yield* Effect.fail(new UsageError({ message: "missing --out <file>, e.g. --out dataset.jsonl" }))
    }
    const text = yield* new ApiClient(settings.url, settings.token).getText("/reflex/export")
    yield* Effect.tryPromise({
      try: () => writeFile(out, text, "utf8"),
      catch: (cause) => new UsageError({ message: `cannot write --out file: ${messageOf(cause)}` }),
    })
    return { out, lines: text.split("\n").filter((line) => line !== "").length }
  })
