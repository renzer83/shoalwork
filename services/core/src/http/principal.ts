import { type McpScope, McpTokens } from "@shoalwork/lead"
import type { Indexer } from "@shoalwork/reef"
import { Data, Effect } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"

// Who sent a request. The API token is the operator (CLI, Telegram): no restriction. An execution token belongs to
// one Bot run and answers only for the Bot and repo it was issued for; the routes ignore repo/bot in the query then.
export type Principal = { readonly kind: "api" } | { readonly kind: "execution"; readonly scope: McpScope }

export const API_PRINCIPAL: Principal = { kind: "api" }

// A valid credential asking for something outside its scope (another repo, another Bot's memory or chunk).
export class ScopeViolation extends Data.TaggedError("ScopeViolation")<{ readonly where: string }> {}

export type McpServices = McpTokens | Indexer | SqlClient

// Same bivariance trick as RunEffect: the runner for the whole AppServices also fits.
export type RunMcp = {
  bivarianceHack<A, E>(eff: Effect.Effect<A, E, McpServices>): Promise<A>
}["bivarianceHack"]

// Set by the auth middleware, read by the routes. Keyed by the Request so no Hono typing is needed.
const principals = new WeakMap<Request, Principal>()

export const setPrincipal = (request: Request, principal: Principal): void => {
  principals.set(request, principal)
}

export const principalOf = (request: Request): Principal | undefined => principals.get(request)

// The only routes an execution token may call. Everything else answers 401 to it, whatever the route checks.
const CHUNK_PATH = /^\/reef\/chunk\/[^/]+$/

export const isExecutionReadPath = (method: string, path: string): boolean =>
  method === "GET" && (path === "/reef/search" || path === "/memory" || CHUNK_PATH.test(path))

// Unknown, revoked and expired tokens are not a principal (401). Database failures stay errors (500).
export const authenticateExecution = (
  token: string,
): Effect.Effect<Principal | undefined, SqlError, McpTokens> =>
  Effect.flatMap(McpTokens, (tokens) => tokens.verify(token)).pipe(
    Effect.map((scope): Principal => ({ kind: "execution", scope })),
    Effect.catchTag("McpTokenRejected", () => Effect.succeed(undefined)),
  )
