import { randomUUID } from "node:crypto"
import { rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { Beacon, BeaconTest } from "@shoalwork/beacon"
import { BotId, streamIds } from "@shoalwork/contracts"
import { withTempDb } from "@shoalwork/db/testing"
import { Effect, Layer, Redacted, Schema, Stream } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import { encrypt } from "../src/crypto.js"
import { SecretNotFound, Vault, VaultLive } from "../src/vault.js"

const KEY = "fixture-vault-key"
const BOT_A = "bot_11111111-2222-3333-4444-555555555555"
const BOT_B = "bot_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
const BOT_A_ID = Schema.decodeUnknownSync(BotId)(BOT_A)
const BOT_B_ID = Schema.decodeUnknownSync(BotId)(BOT_B)

const base = () => Layer.provideMerge(BeaconTest, withTempDb())

const envVault = () =>
  Layer.provideMerge(
    VaultLive({ env: { API_KEY: "env-secret-value", GLOBAL_KEY: "env-global-value" } }),
    base(),
  )

const fileVault = (path: string) => Layer.provideMerge(VaultLive({ vaultFile: path, vaultKey: KEY }), base())

describe("Vault", () => {
  it.effect("file backend decrypts the VAULT_FILE and returns the value", () => {
    const path = join(tmpdir(), `shoalwork-vault-${randomUUID()}.json`)
    writeFileSync(path, encrypt(JSON.stringify({ API_KEY: "file-secret-value" }), KEY))
    return Effect.gen(function* () {
      const sql = yield* SqlClient
      yield* sql`INSERT INTO secrets (key, scope, bot_id, backend_ref, shared)
        VALUES ('API_KEY', 'bot', ${BOT_A}, 'file:API_KEY', 0)`
      const vault = yield* Vault
      expect(Redacted.value(yield* vault.get(BOT_A_ID, "API_KEY"))).toBe("file-secret-value")
    }).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(path, { force: true }))),
      Effect.scoped,
      Effect.provide(fileVault(path)),
    )
  })

  it.effect("a Bot reads its own secret; another Bot is denied (scope)", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      yield* sql`INSERT INTO secrets (key, scope, bot_id, backend_ref, shared)
        VALUES ('API_KEY', 'bot', ${BOT_A}, 'env:API_KEY', 0)`
      const vault = yield* Vault
      expect(Redacted.value(yield* vault.get(BOT_A_ID, "API_KEY"))).toBe("env-secret-value")
      const denied = yield* Effect.flip(vault.get(BOT_B_ID, "API_KEY"))
      expect(denied).toBeInstanceOf(SecretNotFound)
    }).pipe(Effect.provide(envVault())),
  )

  it.effect("a shared global secret is readable by any Bot; a non-shared global is not", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      yield* sql`INSERT INTO secrets (key, scope, bot_id, backend_ref, shared)
        VALUES ('GLOBAL_KEY', 'global', '', 'env:GLOBAL_KEY', 1)`
      yield* sql`INSERT INTO secrets (key, scope, bot_id, backend_ref, shared)
        VALUES ('PRIVATE_GLOBAL', 'global', '', 'env:GLOBAL_KEY', 0)`
      const vault = yield* Vault
      expect(Redacted.value(yield* vault.get(BOT_B_ID, "GLOBAL_KEY"))).toBe("env-global-value")
      const denied = yield* Effect.flip(vault.get(BOT_B_ID, "PRIVATE_GLOBAL"))
      expect(denied).toBeInstanceOf(SecretNotFound)
    }).pipe(Effect.provide(envVault())),
  )

  it.effect("get fails with SecretNotFound for an unknown key", () =>
    Effect.gen(function* () {
      const vault = yield* Vault
      const error = yield* Effect.flip(vault.get(BOT_A_ID, "MISSING"))
      expect(error).toBeInstanceOf(SecretNotFound)
    }).pipe(Effect.provide(envVault())),
  )

  it.effect("get emits a secret.accessed event naming only botId and key", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      yield* sql`INSERT INTO secrets (key, scope, bot_id, backend_ref, shared)
        VALUES ('API_KEY', 'bot', ${BOT_A}, 'env:API_KEY', 0)`
      const vault = yield* Vault
      const beacon = yield* Beacon
      yield* vault.get(BOT_A_ID, "API_KEY")
      const events = yield* Stream.runCollect(beacon.readAll(0, ["secret.accessed"]))
      expect(events).toHaveLength(1)
      expect(events[0]?.streamId).toBe(streamIds.bot(BOT_A_ID))
      expect(events[0]?.payload).toEqual({ botId: BOT_A, key: "API_KEY" })
      expect(JSON.stringify(events[0]?.payload)).not.toContain("env-secret-value")
    }).pipe(Effect.provide(envVault())),
  )
})
