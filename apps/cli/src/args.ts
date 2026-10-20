import { Data, Effect } from "effect"

export class UsageError extends Data.TaggedError("UsageError")<{ readonly message: string }> {}

export type Flags = Readonly<Record<string, string>>

export interface ParsedArgs {
  readonly flags: Flags
  readonly positionals: ReadonlyArray<string>
}

export interface Settings {
  readonly url: string
  readonly token: string
}

// `--name value` pairs plus positional arguments. Only the names a command declares are accepted. The value is the
// next argument whatever it looks like, so a prompt that starts with "--" is still data.
export const parseArgs = (
  argv: ReadonlyArray<string>,
  known: ReadonlyArray<string>,
): Effect.Effect<ParsedArgs, UsageError> => {
  const flags: Record<string, string> = {}
  const positionals: Array<string> = []
  let i = 0
  while (i < argv.length) {
    const token = argv[i] ?? ""
    if (!token.startsWith("--")) {
      positionals.push(token)
      i += 1
      continue
    }
    const name = token.slice(2)
    if (!known.includes(name)) {
      return Effect.fail(new UsageError({ message: `unknown argument: ${token}` }))
    }
    const value = argv[i + 1]
    if (value === undefined) {
      return Effect.fail(new UsageError({ message: `${token} needs a value` }))
    }
    flags[name] = value
    i += 2
  }
  return Effect.succeed({ flags, positionals })
}

// Flags win over the environment; a missing value is a usage error, not a default.
export const resolveSettings = (
  flags: Flags,
  env: Readonly<Record<string, string | undefined>>,
): Effect.Effect<Settings, UsageError> => {
  const url = flags.url ?? env.APP_URL
  const token = flags.token ?? env.API_TOKEN
  if (url === undefined || url === "") {
    return Effect.fail(new UsageError({ message: "missing base URL: pass --url or set APP_URL" }))
  }
  if (token === undefined || token === "") {
    return Effect.fail(new UsageError({ message: "missing token: pass --token or set API_TOKEN" }))
  }
  return Effect.succeed({ url, token })
}
