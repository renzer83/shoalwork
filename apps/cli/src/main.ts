#!/usr/bin/env node
import type { SchemaViolation } from "@shoalwork/contracts"
import { Console, Effect } from "effect"
import { parseArgs, resolveSettings, UsageError } from "./args.js"
import { ApiClient, Health, type HttpError } from "./client.js"
import { approvalDecide } from "./commands/approve.js"
import { controlScope, controlStatus, controlStopTask } from "./commands/control.js"
import { costsReport, renderCosts } from "./commands/costs.js"
import { eventsList } from "./commands/events.js"
import { memoryAdd, memoryEdit, memoryForget, memoryHistory, memorySearch } from "./commands/memory.js"
import { memoryImport } from "./commands/memory-import.js"
import { reflexExport } from "./commands/reflex.js"
import { taskSend, taskShow } from "./commands/task.js"
import { tideCommand } from "./commands/tide.js"

type CliError = UsageError | HttpError | SchemaViolation

const USAGE = [
  "usage: shoalwork health [--url <base-url>] [--token <token>]",
  "       shoalwork task send --bot <bot id> --prompt <text> [--kind <kind>] [--repo <url> [--base <branch>]] [--tier <tier>]",
  "       shoalwork task show <task id>",
  "       shoalwork stop [--bot <bot id or name>] | shoalwork stop task <task id>",
  "       shoalwork pause [--bot <bot id or name>]",
  "       shoalwork resume [--bot <bot id or name>]",
  "       shoalwork approve <approval id> | shoalwork deny <approval id>",
  "       shoalwork status",
  "       shoalwork events --stream <stream id> [--after <version>]",
  "       shoalwork costs [--by task|bot|executor] [--since <iso|7d>] [--compare <iso|14d>] [--json]",
  "       shoalwork tide list [--bot <bot id or name>] | shoalwork tide add --bot <bot> --file <tide.json>",
  "       shoalwork tide enable|disable <tide id> | shoalwork tide run <tide id>",
  "       shoalwork tide add ... --webhook (prints the secret once) | shoalwork tide webhook <tide id> (new secret)",
  "       shoalwork reflex export --out <file>",
  "       shoalwork memory import --dir <dir> --scope global|bot:<name> --kind semantic|procedural --source <label>",
  "       shoalwork memory search --bot <bot id or name> <query> [--k <1..100>] [--kinds <kind,kind>]",
  "       shoalwork memory add --scope global|bot:<name> --kind semantic|procedural --content <text> [--user <id>]",
  "       shoalwork memory edit <memory id> --content <text> [--user <id>]",
  "       shoalwork memory forget <memory id>",
  "       shoalwork memory history <memory id>",
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

const CONTROL_FLAGS = ["bot", ...SETTINGS_FLAGS]

// stop | pause | resume: the whole system, or one Bot with --bot. `stop task <id>` stops a single task.
const control = (
  action: "stop" | "pause" | "resume",
  argv: ReadonlyArray<string>,
): Effect.Effect<void, CliError> =>
  Effect.gen(function* () {
    const { flags, positionals } = yield* parseArgs(argv, CONTROL_FLAGS)
    const settings = yield* resolveSettings(flags, process.env)
    const [first, second, ...extra] = positionals
    if (action === "stop" && first === "task") {
      if (second === undefined || extra.length > 0 || flags.bot !== undefined) {
        return yield* Effect.fail(new UsageError({ message: "usage: stop task <task id>" }))
      }
      yield* Console.log(JSON.stringify(yield* controlStopTask(settings, second)))
      return
    }
    if (first !== undefined) {
      return yield* Effect.fail(new UsageError({ message: `unexpected argument: ${first}` }))
    }
    yield* Console.log(JSON.stringify(yield* controlScope(settings, action, flags)))
  })

// approve | deny: one approval id, decided once; a second call only reports what was decided.
const approval = (
  decision: "approved" | "denied",
  argv: ReadonlyArray<string>,
): Effect.Effect<void, CliError> =>
  Effect.gen(function* () {
    const { flags, positionals } = yield* parseArgs(argv, SETTINGS_FLAGS)
    const [id, ...extra] = positionals
    if (id === undefined || extra.length > 0) {
      return yield* Effect.fail(
        new UsageError({ message: `usage: ${decision === "approved" ? "approve" : "deny"} <approval id>` }),
      )
    }
    const settings = yield* resolveSettings(flags, process.env)
    yield* Console.log(JSON.stringify(yield* approvalDecide(settings, decision, id)))
  })

const status = (argv: ReadonlyArray<string>): Effect.Effect<void, CliError> =>
  Effect.gen(function* () {
    const { flags } = yield* parseArgs(argv, SETTINGS_FLAGS)
    const settings = yield* resolveSettings(flags, process.env)
    yield* Console.log(JSON.stringify(yield* controlStatus(settings), null, 2))
  })

// --json is a switch, not a name-value pair, so it is taken out before the parser sees the arguments.
const costs = (argv: ReadonlyArray<string>): Effect.Effect<void, CliError> =>
  Effect.gen(function* () {
    const json = argv.includes("--json")
    const { flags } = yield* parseArgs(
      argv.filter((arg) => arg !== "--json"),
      ["by", "since", "compare", ...SETTINGS_FLAGS],
    )
    const settings = yield* resolveSettings(flags, process.env)
    const body = yield* costsReport(settings, flags)
    yield* Console.log(renderCosts(body, json))
  })

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

const MEMORY_SUBCOMMANDS = "import|search|add|edit|forget|history"

// One memory id as the positional argument of edit, forget and history.
const memoryId = (positionals: ReadonlyArray<string>, sub: string): Effect.Effect<string, UsageError> => {
  const [id, ...extra] = positionals
  return id === undefined || extra.length > 0
    ? Effect.fail(new UsageError({ message: `usage: memory ${sub} <memory id>` }))
    : Effect.succeed(id)
}

const memory = (argv: ReadonlyArray<string>): Effect.Effect<void, CliError> => {
  const [sub, ...rest] = argv
  switch (sub) {
    case "import":
      return Effect.gen(function* () {
        const { flags } = yield* parseArgs(rest, ["dir", "scope", "kind", "source", ...SETTINGS_FLAGS])
        const settings = yield* resolveSettings(flags, process.env)
        const report = yield* memoryImport(settings, flags)
        yield* Console.log(JSON.stringify(report))
      })
    case "search":
      return Effect.gen(function* () {
        const { flags, positionals } = yield* parseArgs(rest, ["bot", "k", "kinds", ...SETTINGS_FLAGS])
        const settings = yield* resolveSettings(flags, process.env)
        const hits = yield* memorySearch(settings, flags, positionals)
        yield* Console.log(JSON.stringify(hits, null, 2))
      })
    case "add":
      return Effect.gen(function* () {
        const { flags } = yield* parseArgs(rest, ["scope", "kind", "content", "user", ...SETTINGS_FLAGS])
        const settings = yield* resolveSettings(flags, process.env)
        const body = yield* memoryAdd(settings, flags)
        yield* Console.log(JSON.stringify(body))
      })
    case "edit":
      return Effect.gen(function* () {
        const { flags, positionals } = yield* parseArgs(rest, ["content", "user", ...SETTINGS_FLAGS])
        const id = yield* memoryId(positionals, "edit")
        const settings = yield* resolveSettings(flags, process.env)
        const body = yield* memoryEdit(settings, id, flags)
        yield* Console.log(JSON.stringify(body))
      })
    case "forget":
      return Effect.gen(function* () {
        const { flags, positionals } = yield* parseArgs(rest, SETTINGS_FLAGS)
        const id = yield* memoryId(positionals, "forget")
        const settings = yield* resolveSettings(flags, process.env)
        yield* Console.log(JSON.stringify(yield* memoryForget(settings, id)))
      })
    case "history":
      return Effect.gen(function* () {
        const { flags, positionals } = yield* parseArgs(rest, SETTINGS_FLAGS)
        const id = yield* memoryId(positionals, "history")
        const settings = yield* resolveSettings(flags, process.env)
        yield* Console.log(JSON.stringify(yield* memoryHistory(settings, id), null, 2))
      })
    default:
      return Effect.fail(
        new UsageError({
          message:
            sub === undefined
              ? `missing memory subcommand (${MEMORY_SUBCOMMANDS})`
              : `unknown memory subcommand: ${sub}`,
        }),
      )
  }
}

const program = (argv: ReadonlyArray<string>): Effect.Effect<void, CliError> => {
  const [command, ...rest] = argv
  switch (command) {
    case "health":
      return health(rest)
    case "task":
      return task(rest)
    case "stop":
    case "pause":
    case "resume":
      return control(command, rest)
    case "approve":
      return approval("approved", rest)
    case "deny":
      return approval("denied", rest)
    case "status":
      return status(rest)
    case "events":
      return events(rest)
    case "costs":
      return costs(rest)
    case "reflex":
      return reflex(rest)
    case "memory":
      return memory(rest)
    case "tide":
      return tideCommand(rest)
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
