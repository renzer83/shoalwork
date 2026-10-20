#!/usr/bin/env node
import type { SchemaViolation } from "@shoalwork/contracts"
import { Console, Data, Effect } from "effect"
import { ApiClient, Health, type HttpError } from "./client.js"

class UsageError extends Data.TaggedError("UsageError")<{ readonly message: string }> {}

type CliError = UsageError | HttpError | SchemaViolation

const USAGE = [
  "usage: shoalwork health [--url <base-url>] [--token <token>]",
  "  flags override the APP_URL and API_TOKEN environment variables",
].join("\n")

interface Invocation {
  readonly url: string | undefined
  readonly token: string | undefined
}

interface Settings {
  readonly url: string
  readonly token: string
}

// Hand-rolled parser: effect/cli is unstable in Effect 4.
const parseArgs = (argv: ReadonlyArray<string>): Effect.Effect<Invocation, UsageError> => {
  const [command, ...rest] = argv
  if (command !== "health") {
    return Effect.fail(
      new UsageError({ message: command === undefined ? "missing command" : `unknown command: ${command}` }),
    )
  }
  let url: string | undefined
  let token: string | undefined
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i] ?? ""
    const value = rest[i + 1]
    if (flag !== "--url" && flag !== "--token") {
      return Effect.fail(new UsageError({ message: `unknown argument: ${flag}` }))
    }
    if (value === undefined || value.startsWith("--")) {
      return Effect.fail(new UsageError({ message: `${flag} needs a value` }))
    }
    if (flag === "--url") {
      url = value
    } else {
      token = value
    }
  }
  return Effect.succeed({ url, token })
}

const resolveSettings = (invocation: Invocation): Effect.Effect<Settings, UsageError> => {
  const url = invocation.url ?? process.env.APP_URL
  const token = invocation.token ?? process.env.API_TOKEN
  if (url === undefined || url === "") {
    return Effect.fail(new UsageError({ message: "missing base URL: pass --url or set APP_URL" }))
  }
  if (token === undefined || token === "") {
    return Effect.fail(new UsageError({ message: "missing token: pass --token or set API_TOKEN" }))
  }
  return Effect.succeed({ url, token })
}

const health = (settings: Settings): Effect.Effect<void, HttpError | SchemaViolation> =>
  new ApiClient(settings.url, settings.token)
    .get("/health", Health)
    .pipe(Effect.flatMap((body) => Console.log(JSON.stringify(body, null, 2))))

const program = (argv: ReadonlyArray<string>): Effect.Effect<void, CliError> =>
  Effect.gen(function* () {
    const invocation = yield* parseArgs(argv)
    const settings = yield* resolveSettings(invocation)
    yield* health(settings)
  })

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
