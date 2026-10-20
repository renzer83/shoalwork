#!/usr/bin/env node
import type { SchemaViolation } from "@shoalwork/contracts"
import { Console, Effect } from "effect"
import { parseArgs, resolveSettings, UsageError } from "./args.js"
import { ApiClient, Health, type HttpError } from "./client.js"
import { eventsList } from "./commands/events.js"
import { memoryImport } from "./commands/memory-import.js"
import { reflexExport } from "./commands/reflex.js"
import { taskSend, taskShow } from "./commands/task.js"

type CliError = UsageError | HttpError | SchemaViolation

const USAGE = [
  "usage: shoalwork health [--url <base-url>] [--token <token>]",
  "       shoalwork task send --bot <bot id> --prompt <text> [--kind <kind>] [--repo <url> [--base <branch>]] [--tier <tier>]",
  "       shoalwork task show <task id>",
  "       shoalwork events --stream <stream id> [--after <version>]",
  "       shoalwork reflex export --out <file>",
  "       shoalwork memory import --dir <dir> --scope global|bot:<name> --kind semantic|procedural --source <label>",
  "  --url / --token override the APP_URL and API_TOKEN environment variables",
].join("\n")

const TASK_SEND_FLAGS = ["bot", "prompt", "kind", "repo", "base", "tier", "url", "token"]
const SETTINGS_FLAGS = ["url", "token"]

// Hand-rolled parser: effect/cli is unstable in Effect 4.
const health = (argv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const { flags } = yield* parseArgs(argv, SETTINGS_FLAGS)
    const settings = yield* resolveSettings(flags, process.env)
    const body = yield* new ApiClient(settings.url, settings.token).get("/health", Health)
    yield* Console.log(JSON.stringify(body, null, 2))
  })

const task = (argv: ReadonlyArray<string>): Effect.Effect<void, CliError | UsageError> => {
  const [sub, ...rest] = argv
  if (sub === "send") {
    return Effect.gen(function* () {
      const { flags } = yield* parseArgs(rest, TASK_SEND_FLAGS)
      const settings = yield* resolveSettings(flags, process.env)
      const created = yield* taskSend(settings, flags)
      yield* Console.log(JSON.stringify(created))
    })
  }
  if (sub === "show") {
    return Effect.gen(function* () {
      const { flags, positionals } = yield* parseArgs(rest, SETTINGS_FLAGS)
      const [id] = positionals
      if (id === undefined) {
        return yield* Effect.fail(new UsageError({ message: "missing task id: task show <task id>" }))
      }
      const settings = yield* resolveSettings(flags, process.env)
      const view = yield* taskShow(settings, id)
      yield* Console.log(JSON.stringify(view, null, 2))
    })
  }
  return Effect.fail(
    new UsageError({
      message: sub === undefined ? "missing task subcommand (send|show)" : `unknown task subcommand: ${sub}`,
    }),
  )
}

const events = (argv: ReadonlyArray<string>): Effect.Effect<void, CliError> =>
  Effect.gen(function* () {
    const { flags } = yield* parseArgs(argv, ["stream", "after", ...SETTINGS_FLAGS])
    const settings = yield* resolveSettings(flags, process.env)
    const body = yield* eventsList(settings, flags)
    yield* Console.log(JSON.stringify(body, null, 2))
  })

const reflex = (argv: ReadonlyArray<string>): Effect.Effect<void, CliError> => {
  const [sub, ...rest] = argv
  if (sub === "export") {
    return Effect.gen(function* () {
      const { flags } = yield* parseArgs(rest, ["out", ...SETTINGS_FLAGS])
      const settings = yield* resolveSettings(flags, process.env)
      const written = yield* reflexExport(settings, flags)
      yield* Console.log(JSON.stringify(written))
    })
  }
  return Effect.fail(
    new UsageError({
      message: sub === undefined ? "missing reflex subcommand (export)" : `unknown reflex subcommand: ${sub}`,
    }),
  )
}

const memory = (argv: ReadonlyArray<string>): Effect.Effect<void, CliError> => {
  const [sub, ...rest] = argv
  if (sub === "import") {
    return Effect.gen(function* () {
      const { flags } = yield* parseArgs(rest, ["dir", "scope", "kind", "source", ...SETTINGS_FLAGS])
      const settings = yield* resolveSettings(flags, process.env)
      const report = yield* memoryImport(settings, flags)
      yield* Console.log(JSON.stringify(report))
    })
  }
  return Effect.fail(
    new UsageError({
      message: sub === undefined ? "missing memory subcommand (import)" : `unknown memory subcommand: ${sub}`,
    }),
  )
}

const program = (argv: ReadonlyArray<string>): Effect.Effect<void, CliError> => {
  const [command, ...rest] = argv
  switch (command) {
    case "health":
      return health(rest)
    case "task":
      return task(rest)
    case "events":
      return events(rest)
    case "reflex":
      return reflex(rest)
    case "memory":
      return memory(rest)
    default:
      return Effect.fail(
        new UsageError({
          message: command === undefined ? "missing command" : `unknown command: ${command}`,
        }),
      )
  }
}

const describe = (error: CliError): string => {
  switch (error._tag) {
    case "UsageError":
      return `${error.message}\n${USAGE}`
    case "HttpError":
      return error.status === 0 ? error.body : `HTTP ${error.status}: ${error.body}`
    case "SchemaViolation":
      return `invalid response from ${error.where}: ${String(error.issue)}`
  }
}

await Effect.runPromise(
  program(process.argv.slice(2)).pipe(
    Effect.catch((error) =>
      Console.error(describe(error)).pipe(
        Effect.andThen(
          Effect.sync(() => {
            process.exitCode = 1
          }),
        ),
      ),
    ),
  ),
)
