import { randomBytes } from "node:crypto"
import type {
  OAuthClientMetadata,
  OAuthClientProvider,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client"
import { nowIso } from "@shoalwork/db"
import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"

// The OAuth state of one remote MCP server. Values are opaque JSON text (tokens, client registration) or plain text.
export interface McpOAuthState {
  readonly tokens?: string | undefined
  readonly clientInfo?: string | undefined
  readonly codeVerifier?: string | undefined
  readonly state?: string | undefined
  // ISO-8601 UTC of the moment the state was issued. The state is the credential of the callback: it expires.
  readonly stateIssuedAt?: string | undefined
  // The pending authorization link. Public by design (it carries the PKCE challenge, never the verifier).
  readonly authUrl?: string | undefined
}

export const STATE_TTL_MS = 10 * 60 * 1000

// Promise-shaped because the SDK calls its OAuthClientProvider through promises. Tokens never leave this store in clear
// text except to the provider that hands them to the transport.
export interface McpOAuthStore {
  readonly get: (serverId: string) => Promise<McpOAuthState>
  readonly set: (serverId: string, patch: McpOAuthState) => Promise<void>
  // Atomic and single use: clears the state and returns its server only when the state matches and was issued after
  // `notBefore` (ISO). A second redemption, a forged state or an expired one finds nothing.
  readonly redeemState: (state: string, notBefore: string) => Promise<string | undefined>
  readonly clear: (serverId: string) => Promise<void>
}

export const makeMemoryOAuthStore = (): McpOAuthStore => {
  const rows = new Map<string, McpOAuthState>()
  return {
    get: async (id) => rows.get(id) ?? {},
    set: async (id, patch) => {
      rows.set(id, { ...rows.get(id), ...patch })
    },
    redeemState: async (state, notBefore) => {
      const hit = [...rows].find(
        ([, row]) => row.state === state && row.stateIssuedAt !== undefined && row.stateIssuedAt > notBefore,
      )
      if (hit === undefined) return undefined
      rows.set(hit[0], { ...hit[1], state: undefined, stateIssuedAt: undefined })
      return hit[0]
    },
    clear: async (id) => {
      rows.delete(id)
    },
  }
}

// Seals and opens a stored value (the Vault's AES-256-GCM envelope in the composition root).
export interface McpCipher {
  readonly seal: (plain: string) => string
  readonly open: (sealed: string) => string
}

const SEALED = ["tokens", "clientInfo", "codeVerifier"] as const

// A value that no longer opens (key rotated, row damaged) counts as absent: the server asks for authorization again.
const tryOpen = (cipher: McpCipher, sealed: string | null): string | undefined => {
  if (sealed === null) return undefined
  try {
    return cipher.open(sealed)
  } catch {
    return undefined
  }
}

// mcp_oauth table (0028). The SDK wants promises, so this adapter is the boundary: the services of the Effect that builds
// the store are captured once and every query runs with them.
export const makeSqlOAuthStore = (cipher: McpCipher): Effect.Effect<McpOAuthStore, never, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const run = Effect.runPromiseWith(yield* Effect.context<never>())
    const get: McpOAuthStore["get"] = (serverId) =>
      run(
        sql<{
          readonly tokens: string | null
          readonly client_info: string | null
          readonly code_verifier: string | null
          readonly state: string | null
          readonly state_issued_at: string | null
          readonly auth_url: string | null
        }>`SELECT tokens, client_info, code_verifier, state, state_issued_at, auth_url
          FROM mcp_oauth WHERE server_id = ${serverId}`.pipe(
          Effect.map((rows): McpOAuthState => {
            const row = rows[0]
            if (row === undefined) return {}
            return {
              tokens: tryOpen(cipher, row.tokens),
              clientInfo: tryOpen(cipher, row.client_info),
              codeVerifier: tryOpen(cipher, row.code_verifier),
              state: row.state ?? undefined,
              stateIssuedAt: row.state_issued_at ?? undefined,
              authUrl: row.auth_url ?? undefined,
            }
          }),
        ),
      )
    return {
      get,
      set: async (serverId, patch) => {
        const merged = { ...(await get(serverId)), ...patch }
        const sealed = Object.fromEntries(
          SEALED.map((key) => {
            const value = merged[key]
            return [key, value === undefined ? null : cipher.seal(value)]
          }),
        )
        await run(
          sql`INSERT INTO mcp_oauth (server_id, tokens, client_info, code_verifier, state, state_issued_at, auth_url, updated_at)
            VALUES (${serverId}, ${sealed.tokens ?? null}, ${sealed.clientInfo ?? null}, ${sealed.codeVerifier ?? null},
              ${merged.state ?? null}, ${merged.stateIssuedAt ?? null}, ${merged.authUrl ?? null}, ${nowIso()})
            ON CONFLICT (server_id) DO UPDATE SET tokens = excluded.tokens, client_info = excluded.client_info,
              code_verifier = excluded.code_verifier, state = excluded.state, state_issued_at = excluded.state_issued_at,
              auth_url = excluded.auth_url, updated_at = excluded.updated_at`,
        )
      },
      redeemState: (state, notBefore) =>
        run(
          sql<{ readonly server_id: string }>`UPDATE mcp_oauth SET state = NULL, state_issued_at = NULL
            WHERE state = ${state} AND state_issued_at > ${notBefore} RETURNING server_id`.pipe(
            Effect.map((rows) => rows[0]?.server_id),
          ),
        ),
      clear: (serverId) => run(sql`DELETE FROM mcp_oauth WHERE server_id = ${serverId}`.pipe(Effect.asVoid)),
    }
  })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const parseJson = (text: string | undefined): unknown => {
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const isTokens = (value: unknown): value is StoredOAuthTokens =>
  isRecord(value) && typeof value.access_token === "string" && typeof value.token_type === "string"

const isClientInfo = (value: unknown): value is StoredOAuthClientInformation =>
  isRecord(value) && typeof value.client_id === "string"

export type OAuthProviderOptions = {
  readonly serverId: string
  readonly serverName: string
  // Where the authorization server sends the user back: the core's GET /oauth/mcp/callback.
  readonly redirectUrl: string
  // Client ID Metadata Document (an https URL that serves this client's metadata). Without it the client registers
  // dynamically (deprecated by the 2026-07-28 spec, still the fallback for servers that have no CIMD support).
  readonly clientMetadataUrl?: string
  readonly scope?: string
  readonly now?: () => number
  readonly store: McpOAuthStore
  // Receives the URL the user must open. The provider never opens a browser.
  readonly onAuthorizationUrl: (url: URL) => void | Promise<void>
}

// OAuthClientProvider for one server. PKCE, the RFC 8707 `resource` parameter and issuer validation are done by the
// SDK's auth(); this class only persists what it hands over, in the store (sealed), never in memory beyond a call.
export const makeOAuthProvider = (opts: OAuthProviderOptions): OAuthClientProvider => {
  const metadata: OAuthClientMetadata = {
    client_name: `shoalwork-${opts.serverName}`,
    redirect_uris: [opts.redirectUrl],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    ...(opts.scope === undefined ? {} : { scope: opts.scope }),
  }
  return {
    get redirectUrl() {
      return opts.redirectUrl
    },
    get clientMetadata() {
      return metadata
    },
    ...(opts.clientMetadataUrl === undefined ? {} : { clientMetadataUrl: opts.clientMetadataUrl }),
    state: async () => {
      const state = randomBytes(24).toString("base64url")
      await opts.store.set(opts.serverId, {
        state,
        stateIssuedAt: new Date((opts.now ?? Date.now)()).toISOString(),
      })
      return state
    },
    clientInformation: async () => {
      const parsed = parseJson((await opts.store.get(opts.serverId)).clientInfo)
      return isClientInfo(parsed) ? parsed : undefined
    },
    saveClientInformation: async (info) => {
      await opts.store.set(opts.serverId, { clientInfo: JSON.stringify(info) })
    },
    tokens: async () => {
      const parsed = parseJson((await opts.store.get(opts.serverId)).tokens)
      return isTokens(parsed) ? parsed : undefined
    },
    saveTokens: async (tokens) => {
      await opts.store.set(opts.serverId, { tokens: JSON.stringify(tokens) })
    },
    redirectToAuthorization: async (url) => {
      await opts.store.set(opts.serverId, { authUrl: url.toString() })
      await opts.onAuthorizationUrl(url)
    },
    saveCodeVerifier: async (codeVerifier) => {
      await opts.store.set(opts.serverId, { codeVerifier })
    },
    codeVerifier: async () => {
      const verifier = (await opts.store.get(opts.serverId)).codeVerifier
      if (verifier === undefined) throw new Error("no PKCE code verifier saved for this server")
      return verifier
    },
    invalidateCredentials: async (scope) => {
      const patch: McpOAuthState =
        scope === "all"
          ? {
              tokens: undefined,
              clientInfo: undefined,
              codeVerifier: undefined,
              state: undefined,
              stateIssuedAt: undefined,
              authUrl: undefined,
            }
          : scope === "tokens"
            ? { tokens: undefined }
            : scope === "client"
              ? { clientInfo: undefined }
              : scope === "verifier"
                ? { codeVerifier: undefined }
                : {}
      await opts.store.set(opts.serverId, patch)
    },
  }
}
