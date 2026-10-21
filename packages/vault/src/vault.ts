import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { promisify } from "node:util"
import { Beacon, type BeaconShape } from "@shoalwork/beacon"
import { type BotId, type Conflict, type SchemaViolation, streamIds } from "@shoalwork/contracts"
import { Context, Data, Effect, Layer, Redacted, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import { decrypt } from "./crypto.js"

const execFileAsync = promisify(execFile)

export class SecretNotFound extends Data.TaggedError("SecretNotFound")<{ botId: string; key: string }> {}
export class SecretBackendError extends Data.TaggedError("SecretBackendError")<{
  backend: string
  cause: unknown
}> {}

export type BackendName = "env" | "file" | "op"

// A backend resolves a reference into the plain secret value. Values are Redacted by the Vault, never logged.
export interface SecretBackend {
  readonly read: (ref: string) => Effect.Effect<string, SecretBackendError>
}

export interface VaultShape {
  readonly get: (
    botId: BotId,
    key: string,
  ) => Effect.Effect<
    Redacted.Redacted<string>,
    SecretNotFound | SecretBackendError | Conflict | SchemaViolation | SqlError
  >
}

export class Vault extends Context.Service<Vault, VaultShape>()("@shoalwork/Vault") {}

// Backends receive their config here; the package never reads process.env (05-conventions §10).
export type VaultConfig = {
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly vaultFile?: string
  readonly vaultKey?: string
}

// `backend_ref` names the backend: env:VAR, file:key, or op://… (06-research §6).
const resolveRef = (
  backendRef: string,
): Effect.Effect<{ readonly backend: BackendName; readonly ref: string }, SecretBackendError> => {
  if (backendRef.startsWith("op://")) return Effect.succeed({ backend: "op", ref: backendRef })
  if (backendRef.startsWith("env:")) return Effect.succeed({ backend: "env", ref: backendRef.slice(4) })
  if (backendRef.startsWith("file:")) return Effect.succeed({ backend: "file", ref: backendRef.slice(5) })
  return Effect.fail(new SecretBackendError({ backend: "ref", cause: `unknown backend_ref: ${backendRef}` }))
}

const makeEnvBackend = (env: Readonly<Record<string, string | undefined>>): SecretBackend => ({
  read: (ref) =>
    Effect.gen(function* () {
      const value = env[ref]
      if (value === undefined) {
        return yield* Effect.fail(
          new SecretBackendError({ backend: "env", cause: `env var not set: ${ref}` }),
        )
      }
      return value
    }),
})

// VAULT_FILE is a JSON object whose whole content is encrypted with VAULT_KEY (AES-256-GCM); `ref` is a key.
const makeFileBackend = (filePath: string, key: string): SecretBackend => ({
  read: (ref) =>
    Effect.try({
      try: (): string => {
        const raw = readFileSync(filePath, "utf8").trim()
        const parsed = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String))(
          JSON.parse(decrypt(raw, key)),
        )
        const value = parsed[ref]
        if (value === undefined) throw new Error(`vault file has no key: ${ref}`)
        return value
      },
      catch: (cause) => new SecretBackendError({ backend: "file", cause }),
    }),
})

// 1Password CLI (06-research §6). Only reachable for backend_ref starting with op://; no network in tests.
const makeOpBackend = (): SecretBackend => ({
  read: (ref) =>
    Effect.tryPromise({
      try: () => execFileAsync("op", ["read", ref]).then(({ stdout }) => stdout.trim()),
      catch: (cause) => new SecretBackendError({ backend: "op", cause }),
    }),
})

export const makeBackends = (config: VaultConfig): Readonly<Record<BackendName, SecretBackend>> => ({
  env: makeEnvBackend(config.env ?? {}),
  file: makeFileBackend(config.vaultFile ?? "", config.vaultKey ?? ""),
  op: makeOpBackend(),
})

const SecretRow = Schema.Struct({ backend_ref: Schema.String })

const makeVault = (
  sql: SqlClient,
  beacon: BeaconShape,
  backends: Readonly<Record<BackendName, SecretBackend>>,
): VaultShape => ({
  get: (botId, key) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly backend_ref: string }>`SELECT backend_ref FROM secrets
        WHERE key = ${key} AND ((scope = 'bot' AND bot_id = ${botId}) OR (scope = 'global' AND shared = 1))
        LIMIT 1`
      const first = rows[0]
      if (first === undefined) {
        return yield* Effect.fail(new SecretNotFound({ botId, key }))
      }
      const { backend, ref } = yield* resolveRef(Schema.decodeUnknownSync(SecretRow)(first).backend_ref)
      const value = yield* backends[backend].read(ref)
      yield* beacon.append({
        streamId: streamIds.bot(botId),
        type: "secret.accessed",
        payload: { botId, key },
        actor: `bot:${botId}`,
        correlationId: `vault:${randomUUID()}`,
      })
      return Redacted.make(value)
    }),
})

export const VaultLive = (config: VaultConfig): Layer.Layer<Vault, never, SqlClient | Beacon> =>
  Layer.effect(
    Vault,
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const beacon = yield* Beacon
      return makeVault(sql, beacon, makeBackends(config))
    }),
  )
