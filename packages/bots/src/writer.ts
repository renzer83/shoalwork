import { randomUUID } from "node:crypto"
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { NewBot, SchemaViolation } from "@shoalwork/contracts"
import { Data, Effect, Schema } from "effect"
import { stringify } from "yaml"

// A Bot file already exists: writing it again would replace a Bot the user did not confirm.
export class BotFileExists extends Data.TaggedError("BotFileExists")<{ readonly path: string }> {}

// A replace needs a definition on disk to replace; a Bot created only in the registry has none.
export class BotFileMissing extends Data.TaggedError("BotFileMissing")<{ readonly path: string }> {}

// The filesystem refused the write; nothing final was written (the temp file is removed).
export class BotWriteError extends Data.TaggedError("BotWriteError")<{
  readonly path: string
  readonly message: string
}> {}

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.name : "write failed")

// Temp file in the same directory, then rename: a reader never sees a half-written definition, and rename replaces
// the directory entry itself, so a symlink at the target is never written through.
const writeFileAtomic = (path: string, text: string): void => {
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temp, text, { flag: "wx" })
    renameSync(temp, path)
  } catch (cause) {
    rmSync(temp, { force: true })
    throw cause
  }
}

type EntryKind = "missing" | "symlink" | "file" | "other"

// lstat, not stat: a symlink is reported as a symlink and never followed.
const entryKind = (path: string): EntryKind => {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (stat === undefined) return "missing"
  if (stat.isSymbolicLink()) return "symlink"
  return stat.isFile() ? "file" : "other"
}

const decodeBot = (bot: NewBot): Effect.Effect<NewBot, SchemaViolation> =>
  Schema.decodeUnknownEffect(NewBot)(bot).pipe(
    Effect.mapError((error) => new SchemaViolation({ where: "bot.yaml", issue: error.issue })),
  )

// Writes bots/<name>.yaml for a new name. The name is validated by NewBot (BotName allowlist), so it cannot carry a path.
export const writeBotYaml = (
  dir: string,
  bot: NewBot,
): Effect.Effect<string, SchemaViolation | BotFileExists | BotWriteError> =>
  Effect.gen(function* () {
    const valid = yield* decodeBot(bot)
    const path = join(dir, `${valid.name}.yaml`)
    if (existsSync(path)) {
      return yield* Effect.fail(new BotFileExists({ path }))
    }
    yield* Effect.try({
      try: () => writeFileAtomic(path, stringify(valid)),
      catch: (cause) => new BotWriteError({ path, message: messageOf(cause) }),
    })
    return path
  })

// Replaces the definition of an existing Bot file. Returns the previous text so the caller can restore it when the
// matching registry write fails. A symlink or a non-file at the target is refused.
export const replaceBotYaml = (
  dir: string,
  bot: NewBot,
): Effect.Effect<string, SchemaViolation | BotFileMissing | BotWriteError> =>
  Effect.gen(function* () {
    const valid = yield* decodeBot(bot)
    const path = join(dir, `${valid.name}.yaml`)
    const kind = entryKind(path)
    if (kind === "missing") {
      return yield* Effect.fail(new BotFileMissing({ path }))
    }
    if (kind !== "file") {
      return yield* Effect.fail(new BotWriteError({ path, message: `refused: ${kind}` }))
    }
    return yield* Effect.try({
      try: () => {
        const previous = readFileSync(path, "utf8")
        writeFileAtomic(path, stringify(valid))
        return previous
      },
      catch: (cause) => new BotWriteError({ path, message: messageOf(cause) }),
    })
  })

// Puts back the text a failed replace returned. The name is the one already validated for that file.
export const restoreBotYaml = (
  dir: string,
  name: string,
  previous: string,
): Effect.Effect<void, BotWriteError> => {
  const path = join(dir, `${name}.yaml`)
  return Effect.try({
    try: () => writeFileAtomic(path, previous),
    catch: (cause) => new BotWriteError({ path, message: messageOf(cause) }),
  })
}
