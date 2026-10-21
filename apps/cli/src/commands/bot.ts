import { readdirSync } from "node:fs"
import { join } from "node:path"
import {
  type BotFileExists,
  type BotWriteError,
  instantiate,
  loadTemplates,
  writeBotYaml,
} from "@shoalwork/bots"
import { BotName, type SchemaViolation } from "@shoalwork/contracts"
import { Console, Effect, Schema } from "effect"
import { parseArgs, UsageError } from "../args.js"

export type BotCommandError = UsageError

const TEMPLATES_DIR = "bots/templates"
const BOTS_DIR = "bots"

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

// The bot commands are local: they read and write the repo's bots/ directory and never call the API.
const writeError = (error: SchemaViolation | BotFileExists | BotWriteError): string => {
  switch (error._tag) {
    case "BotFileExists":
      return `bot already exists: ${error.path}`
    case "BotWriteError":
      return `cannot write bot: ${error.message}`
    case "SchemaViolation":
      return `invalid bot: ${String(error.issue)}`
  }
}

// Instantiates a template for a project and writes bots/<role>-<project>.yaml. Returns the written path.
export const botFromTemplate = (
  root: string,
  role: string,
  project: string,
): Effect.Effect<string, UsageError> =>
  Effect.gen(function* () {
    const name = `${role}-${project}`
    if (!Schema.is(BotName)(name)) {
      return yield* Effect.fail(new UsageError({ message: `invalid bot name: ${name}` }))
    }
    const templates = yield* loadTemplates(join(root, TEMPLATES_DIR)).pipe(
      Effect.mapError(
        (error) => new UsageError({ message: `cannot load templates: ${String(error.issue)}` }),
      ),
    )
    const template = templates.find((t) => t.bot.name === role)
    if (template === undefined) {
      return yield* Effect.fail(new UsageError({ message: `unknown template: ${role}` }))
    }
    const bot = instantiate(template, { project })
    return yield* writeBotYaml(join(root, BOTS_DIR), bot).pipe(
      Effect.mapError((error) => new UsageError({ message: writeError(error) })),
    )
  })

// Lists the Bot names of the repo's bots/ directory (the templates live in bots/templates/ and are not Bots yet).
export const botList = (root: string): Effect.Effect<ReadonlyArray<string>, UsageError> =>
  Effect.gen(function* () {
    const dir = join(root, BOTS_DIR)
    const files = yield* Effect.try({
      try: () =>
        readdirSync(dir)
          .filter((file) => file.endsWith(".yaml"))
          .sort(),
      catch: (cause) => new UsageError({ message: `cannot list bots in ${dir}: ${messageOf(cause)}` }),
    })
    return files.map((file) => file.slice(0, -".yaml".length))
  })

export const botCommand = (argv: ReadonlyArray<string>): Effect.Effect<void, UsageError> => {
  const [sub, ...rest] = argv
  switch (sub) {
    case "from-template":
      return Effect.gen(function* () {
        const { flags, positionals } = yield* parseArgs(rest, ["project"])
        const [role, ...extra] = positionals
        if (role === undefined || extra.length > 0) {
          return yield* Effect.fail(
            new UsageError({ message: "usage: bot from-template <role> --project <slug>" }),
          )
        }
        const project = flags.project
        if (project === undefined) {
          return yield* Effect.fail(new UsageError({ message: "bot from-template needs --project <slug>" }))
        }
        const path = yield* botFromTemplate(process.cwd(), role, project)
        yield* Console.log(path)
      })
    case "list":
      return Effect.gen(function* () {
        if (rest.length > 0) {
          return yield* Effect.fail(new UsageError({ message: "usage: bot list" }))
        }
        const names = yield* botList(process.cwd())
        yield* Console.log(names.join("\n"))
      })
    default:
      return Effect.fail(
        new UsageError({
          message:
            sub === undefined
              ? "missing bot subcommand (from-template|list)"
              : `unknown bot subcommand: ${sub}`,
        }),
      )
  }
}
