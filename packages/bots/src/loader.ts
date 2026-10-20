import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  DEFAULT_COOLDOWN_SECONDS,
  DEFAULT_MAX_FIRES_PER_HOUR,
  EventType,
  FilterValue,
  NewBot,
  type NewTide,
  SchemaViolation,
  TideName,
  TideTemplate,
  tideShapeIssue,
} from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import { parse } from "yaml"

export interface BotEntry {
  readonly path: string
  readonly bot: NewBot
  // Tides declared under `tides:` in the same file, already in the NewTide shape (enabled by default).
  readonly tides: ReadonlyArray<NewTide>
}

const BOT_FILE = /\.yaml$/

// A Tide as written in bots/*.yaml: either `cron` or `on` (an event type), an optional `filter`, and the `task`.
const TideYaml = Schema.Struct({
  name: TideName,
  cron: Schema.optional(Schema.String),
  on: Schema.optional(EventType),
  filter: Schema.optional(Schema.Record(Schema.String, FilterValue)),
  timezone: Schema.optional(Schema.String),
  // Seconds between two firings, and firings per rolling hour (the defaults of the Tide schema when omitted).
  cooldown: Schema.optional(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
  maxPerHour: Schema.optional(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1)))),
  task: TideTemplate,
})
type TideYaml = typeof TideYaml.Type

// Only the `tides` key is read here; the rest of the file is decoded as the Bot (unknown keys are not part of a Bot).
const TidesYaml = Schema.Struct({ tides: Schema.optional(Schema.Array(TideYaml)) })

// A yaml tide with both `cron` and `on` (or neither) keeps the kind it implies; tideShapeIssue then rejects it.
const toNewTide = (raw: TideYaml): NewTide => ({
  name: raw.name,
  kind: raw.cron === undefined ? "event" : "cron",
  timezone: raw.timezone ?? "UTC",
  cooldownSeconds: raw.cooldown ?? DEFAULT_COOLDOWN_SECONDS,
  maxFiresPerHour: raw.maxPerHour ?? DEFAULT_MAX_FIRES_PER_HOUR,
  taskTemplate: raw.task,
  enabled: true,
  ...(raw.cron === undefined ? {} : { cronExpr: raw.cron }),
  ...(raw.on === undefined ? {} : { eventType: raw.on }),
  ...(raw.filter === undefined ? {} : { eventFilter: raw.filter }),
})

// Every failure (read, YAML syntax, schema, tide shape) is reported as SchemaViolation at the file path.
const readBotFile = (
  path: string,
): Effect.Effect<{ readonly bot: NewBot; readonly tides: ReadonlyArray<NewTide> }, SchemaViolation> =>
  Effect.gen(function* () {
    const text = yield* Effect.try({
      try: () => readFileSync(path, "utf8"),
      catch: (cause) => new SchemaViolation({ where: path, issue: cause }),
    })
    const raw = yield* Effect.try({
      try: (): unknown => parse(text),
      catch: (cause) => new SchemaViolation({ where: path, issue: cause }),
    })
    const bot = yield* Schema.decodeUnknownEffect(NewBot)(raw).pipe(
      Effect.mapError((e) => new SchemaViolation({ where: path, issue: e.issue })),
    )
    const declared = yield* Schema.decodeUnknownEffect(TidesYaml)(raw).pipe(
      Effect.mapError((e) => new SchemaViolation({ where: path, issue: e.issue })),
    )
    const tides = (declared.tides ?? []).map(toNewTide)
    const names = new Set<string>()
    for (const tide of tides) {
      const issue = tideShapeIssue(tide)
      if (issue !== undefined) {
        return yield* Effect.fail(
          new SchemaViolation({ where: path, issue: `tide "${tide.name}": ${issue}` }),
        )
      }
      if (names.has(tide.name)) {
        return yield* Effect.fail(
          new SchemaViolation({ where: path, issue: `duplicate tide name "${tide.name}" in one bot` }),
        )
      }
      names.add(tide.name)
    }
    return { bot, tides }
  })

export const loadBotFile = (path: string): Effect.Effect<NewBot, SchemaViolation> =>
  Effect.map(readBotFile(path), (entry) => entry.bot)

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
      const { bot, tides } = yield* readBotFile(path)
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
      entries.push({ path, bot, tides })
    }
    return entries
  })

export const loadBotDir = (dir: string): Effect.Effect<ReadonlyArray<NewBot>, SchemaViolation> =>
  Effect.map(loadBotEntries(dir), (entries) => entries.map((entry) => entry.bot))
