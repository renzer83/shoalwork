import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { NewBot, SchemaViolation } from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import { parse } from "yaml"

export interface BotEntry {
  readonly path: string
  readonly bot: NewBot
}

const BOT_FILE = /\.yaml$/

// Every failure (read, YAML syntax, schema) is reported as SchemaViolation at the file path.
export const loadBotFile = (path: string): Effect.Effect<NewBot, SchemaViolation> =>
  Effect.gen(function* () {
    const text = yield* Effect.try({
      try: () => readFileSync(path, "utf8"),
      catch: (cause) => new SchemaViolation({ where: path, issue: cause }),
    })
    const raw = yield* Effect.try({
      try: (): unknown => parse(text),
      catch: (cause) => new SchemaViolation({ where: path, issue: cause }),
    })
    return yield* Schema.decodeUnknownEffect(NewBot)(raw).pipe(
      Effect.mapError((e) => new SchemaViolation({ where: path, issue: e.issue })),
    )
  })

// Every *.yaml file of the directory, validated. Two files with the same bot name are rejected.
export const loadBotEntries = (dir: string): Effect.Effect<ReadonlyArray<BotEntry>, SchemaViolation> =>
  Effect.gen(function* () {
    const files = yield* Effect.try({
      try: () =>
        readdirSync(dir)
          .filter((file) => BOT_FILE.test(file))
          .sort(),
      catch: (cause) => new SchemaViolation({ where: dir, issue: cause }),
    })
    const entries: Array<BotEntry> = []
    const seen = new Map<string, string>()
    for (const file of files) {
      const path = join(dir, file)
      const bot = yield* loadBotFile(path)
      const first = seen.get(bot.name)
      if (first !== undefined) {
        return yield* Effect.fail(
          new SchemaViolation({
            where: path,
            issue: `duplicate bot name "${bot.name}" (already in ${first})`,
          }),
        )
      }
      seen.set(bot.name, path)
      entries.push({ path, bot })
    }
    return entries
  })

export const loadBotDir = (dir: string): Effect.Effect<ReadonlyArray<NewBot>, SchemaViolation> =>
  Effect.map(loadBotEntries(dir), (entries) => entries.map((entry) => entry.bot))
