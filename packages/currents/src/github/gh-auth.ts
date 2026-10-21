import { Effect } from "effect"
import { type GhEnv, GhError } from "./gh-process.js"

// Who a gh call acts as: the Bot's own gh login (default, the Bot's HOME), or a GitHub App installation, whose
// token travels in GH_TOKEN of that call's env only. Never in argv, never in an event or a log line.
export type GhAuth = "gh" | { readonly installationId: number }

// Resolves the installation token for a call. Errors must not carry the token.
export type InstallationTokens = (installationId: number) => Effect.Effect<string, GhError>

export const authedEnv = (
  op: string,
  env: GhEnv,
  auth: GhAuth | undefined,
  tokens: InstallationTokens | undefined,
): Effect.Effect<GhEnv, GhError> => {
  if (auth === undefined || auth === "gh") return Effect.succeed(env)
  if (tokens === undefined) {
    return Effect.fail(new GhError({ op, message: `${op} needs an installation token, none is configured` }))
  }
  return tokens(auth.installationId).pipe(Effect.map((token) => ({ ...env, GH_TOKEN: token })))
}
