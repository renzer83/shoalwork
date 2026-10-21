import { createAppAuth } from "@octokit/auth-app"
import { Context, Data, Effect, Layer, Redacted, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { Octokit } from "octokit"

// Any failure of the GitHub App path. The message never carries a token, a key or a response body.
export class GithubError extends Data.TaggedError("GithubError")<{
  readonly op: string
  readonly message: string
}> {}

export interface GithubAppConfig {
  readonly appId: string
  readonly privateKey: Redacted.Redacted<string>
  // Injected for tests and for the core's own transport; defaults to the global fetch.
  readonly fetch?: typeof fetch
  // Injected clock (epoch ms) for the token cache; defaults to Date.now.
  readonly now?: () => number
}

export interface GithubAppShape {
  // An Octokit that authenticates with the installation's token (renewed when close to expiry).
  readonly installationOctokit: (installationId: number) => Effect.Effect<Octokit, GithubError>
  readonly tokenForInstallation: (installationId: number) => Effect.Effect<string, GithubError>
  // The installation whose repos include `repo` ("owner/name", case-insensitive).
  readonly installationIdFor: (repo: string) => Effect.Effect<number, GithubError>
  readonly tokenFor: (repo: string) => Effect.Effect<string, GithubError>
}

export class GithubApp extends Context.Service<GithubApp, GithubAppShape>()("@shoalwork/GithubApp") {}

// GitHub issues installation tokens for one hour; a token is replaced once less than this much remains.
export const TOKEN_RENEW_BEFORE_MS = 5 * 60 * 1000

interface CachedToken {
  readonly token: string
  readonly expiresAtMs: number
}

const InstallationRow = Schema.Struct({ installation_id: Schema.Int })

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : "unknown failure")

export const makeGithubApp = (config: GithubAppConfig, sql: SqlClient): GithubAppShape => {
  const fetchImpl: typeof fetch = config.fetch ?? fetch
  const now = config.now ?? Date.now
  const api = new Octokit({ request: { fetch: fetchImpl } })
  const authenticate = createAppAuth({
    appId: config.appId,
    privateKey: Redacted.value(config.privateKey),
    request: api.request,
  })

  const cache = new Map<number, CachedToken>()
  const inFlight = new Map<number, Promise<CachedToken>>()

  // One mint per installation at a time: concurrent callers share the same request.
  const mint = (installationId: number): Promise<CachedToken> => {
    const pending = inFlight.get(installationId)
    if (pending !== undefined) return pending
    const promise = authenticate({ type: "installation", installationId, refresh: true })
      .then((auth) => {
        if (!("expiresAt" in auth)) throw new Error("GitHub App returned no installation token")
        const entry: CachedToken = { token: auth.token, expiresAtMs: Date.parse(auth.expiresAt) }
        cache.set(installationId, entry)
        return entry
      })
      .finally(() => inFlight.delete(installationId))
    inFlight.set(installationId, promise)
    return promise
  }

  const tokenForInstallation = (installationId: number): Effect.Effect<string, GithubError> =>
    Effect.suspend(() => {
      const hit = cache.get(installationId)
      if (hit !== undefined && hit.expiresAtMs - now() > TOKEN_RENEW_BEFORE_MS) {
        return Effect.succeed(hit.token)
      }
      return Effect.tryPromise({
        try: () => mint(installationId),
        catch: (cause) => new GithubError({ op: "installation token", message: messageOf(cause) }),
      }).pipe(Effect.map((entry) => entry.token))
    })

  const installationIdFor = (repo: string): Effect.Effect<number, GithubError> =>
    sql<{
      readonly installation_id: number
    }>`SELECT installation_id FROM github_installations, json_each(github_installations.repos)
      WHERE lower(json_each.value) = lower(${repo}) ORDER BY installation_id LIMIT 1`.pipe(
      Effect.mapError(
        () => new GithubError({ op: "installation lookup", message: "installation lookup failed" }),
      ),
      Effect.flatMap((rows) =>
        Schema.decodeUnknownEffect(Schema.Array(InstallationRow))(rows).pipe(
          Effect.mapError(
            () => new GithubError({ op: "installation lookup", message: "installation row is malformed" }),
          ),
        ),
      ),
      Effect.flatMap((rows) => {
        const first = rows[0]
        return first === undefined
          ? Effect.fail(
              new GithubError({ op: "installation lookup", message: `no installation covers ${repo}` }),
            )
          : Effect.succeed(first.installation_id)
      }),
    )

  return {
    installationOctokit: (installationId) =>
      tokenForInstallation(installationId).pipe(
        Effect.map((token) => new Octokit({ auth: token, request: { fetch: fetchImpl } })),
      ),
    tokenForInstallation,
    installationIdFor,
    tokenFor: (repo) => installationIdFor(repo).pipe(Effect.flatMap(tokenForInstallation)),
  }
}

// The App id and key come from the composition root (the key is read from the Vault there).
export const GithubAppLive = (config: GithubAppConfig): Layer.Layer<GithubApp, never, SqlClient> =>
  Layer.effect(
    GithubApp,
    Effect.map(SqlClient, (sql) => makeGithubApp(config, sql)),
  )
