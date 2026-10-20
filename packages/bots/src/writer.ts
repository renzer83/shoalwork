import { randomUUID } from "node:crypto"
import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { NewBot, SchemaViolation } from "@shoalwork/contracts"
import { Data, Effect, Schema } from "effect"
import { stringify } from "yaml"

// A Bot file already exists: writing it again would replace a Bot the user did not confirm.
export class BotFileExists extends Data.TaggedError("BotFileExists")<{ readonly path: string }> {}

// The filesystem refused the write; nothing final was written (the temp file is removed).
export class BotWriteError extends Data.TaggedError("BotWriteError")<{
  readonly path: string
  readonly message: string
}> {}

// Writes bots/<name>.yaml. The name is validated by NewBot (BotName allowlist), so it cannot carry a path.
// Temp file in the same directory, then rename: a reader never sees a half-written definition.
export const writeBotYaml = (
  dir: string,
  bot: NewBot,
): Effect.Effect<string, SchemaViolation | BotFileExists | BotWriteError> =>
  Effect.gen(function* () {
    const valid = yield* Schema.decodeUnknownEffect(NewBot)(bot).pipe(
      Effect.mapError((error) => new SchemaViolation({ where: dir, issue: error.issue })),
    )
    const path = join(dir, `${valid.name}.yaml`)
    if (existsSync(path)) {
      return yield* Effect.fail(new BotFileExists({ path }))
    }
    const temp = join(dir, `.${valid.name}.${randomUUID()}.tmp`)
    yield* Effect.try({
      try: () => {
        writeFileSync(temp, stringify(valid), { flag: "wx" })
        renameSync(temp, path)
      },
      catch: (cause) => {
        rmSync(temp, { force: true })
        return new BotWriteError({ path, message: messageOf(cause) })
      },
    })
    return path
  })

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.name : "write failed")
