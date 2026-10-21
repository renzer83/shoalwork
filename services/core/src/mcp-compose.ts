import { Beacon, type BeaconShape } from "@shoalwork/beacon"
import { BotId, streamIds } from "@shoalwork/contracts"
import {
  type McpAuthNeeded,
  type McpCipher,
  McpRegistry,
  McpRegistryLive,
  type McpSecrets,
  makeSqlOAuthStore,
  TelegramOut,
  type TelegramOutShape,
} from "@shoalwork/currents"
import { McpToolHosts } from "@shoalwork/executors"
import { appChannelOut, BotMcp, makeReplyPort, telegramChannelOut } from "@shoalwork/lead"
import { Policy } from "@shoalwork/policy"
import { decrypt, encrypt, Vault, VaultLive, type VaultShape } from "@shoalwork/vault"
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { type AppConfigShape, coreApiOrigin, hostEnvSnapshot } from "./config.js"
import { MCP_OAUTH_CALLBACK_PATH } from "./http/routes/mcp-servers.js"
import { makeBotMcp, makeMcpToolHosts } from "./mcp-run.js"
import { TelegramStatus } from "./telegram.js"

// The Vault of the product (T-064): VAULT_FILE and VAULT_KEY for the file backend; env: and op:// refs work without them.
export const VaultFromConfig = (config: Pick<AppConfigShape, "vaultFile" | "vaultKey">) =>
  VaultLive({
    env: hostEnvSnapshot(),
    ...Option.match(config.vaultFile, { onNone: () => ({}), onSome: (vaultFile) => ({ vaultFile }) }),
    ...Option.match(config.vaultKey, {
      onNone: () => ({}),
      onSome: (key) => ({ vaultKey: Redacted.value(key) }),
    }),
  })

// The secrets a server names are the Bot's own, by Vault key. A registry call with no Bot has none (`test` of a server that
// needs a secret must name the Bot).
export const vaultSecrets =
  (vault: VaultShape) =>
  (botId: BotId | undefined): McpSecrets => ({
    get: (key) =>
      botId === undefined ? Effect.fail(new Error("no Bot to read the secret for")) : vault.get(botId, key),
  })

// The OAuth store seals its tokens with the Vault's key (AES-256-GCM, T-064).
export const vaultCipher = (key: string): McpCipher => ({
  seal: (plain) => encrypt(plain, key),
  open: (sealed) => decrypt(sealed, key),
})

// The registry is built below the Lead and the Telegram connector is built above it, so the authorization link goes out
// through a slot that the top of the layer stack binds (like the Pods' inbound port).
export interface McpNotifySlotShape {
  readonly notify: (needed: McpAuthNeeded) => Effect.Effect<void>
  readonly bind: (handler: (needed: McpAuthNeeded) => Effect.Effect<void>) => void
}

export class McpNotifySlot extends Context.Service<McpNotifySlot, McpNotifySlotShape>()(
  "@shoalwork/McpNotifySlot",
) {}

export const McpNotifySlotLive: Layer.Layer<McpNotifySlot> = Layer.sync(McpNotifySlot, () => {
  let handler: (needed: McpAuthNeeded) => Effect.Effect<void> = () =>
    Effect.logWarning("an MCP authorization link was due before the channels were bound; dropped")
  return {
    notify: (needed) => handler(needed),
    bind: (next) => {
      handler = next
    },
  }
})

export interface OAuthNotifier {
  readonly notify: (needed: McpAuthNeeded) => Effect.Effect<void>
}

// Where the authorization link goes: the Bot that uses the server (the first one by id), over Telegram when it runs, else
// the app channel. The event names the server only: the link is in the message, never in the audit record.
export const makeOAuthNotifier = (deps: {
  readonly sql: SqlClient
  readonly beacon: BeaconShape
  readonly telegram: TelegramOutShape
  readonly telegramOn: boolean
}): OAuthNotifier => {
  const reply = makeReplyPort({
    app: appChannelOut(deps.beacon),
    telegram: telegramChannelOut(deps.telegram),
  })
  return {
    notify: (needed) =>
      Effect.gen(function* () {
        const rows = yield* deps.sql<{ readonly bot_id: string }>`SELECT b.bot_id FROM bot_mcp b
          JOIN mcp_servers s ON s.id = b.server_id WHERE s.name = ${needed.server} ORDER BY b.bot_id LIMIT 1`
        const botId =
          rows[0] === undefined ? undefined : yield* Schema.decodeUnknownEffect(BotId)(rows[0].bot_id)
        yield* deps.beacon.append({
          streamId: botId === undefined ? streamIds.system : streamIds.bot(botId),
          type: "mcp.server_changed",
          payload: { action: "auth_requested", server: needed.server },
          actor: "system:mcp",
          correlationId: crypto.randomUUID(),
        })
        if (botId === undefined) return
        yield* reply.send(
          deps.telegramOn ? "telegram" : "app",
          botId,
          `The MCP server "${needed.server}" needs authorization. Open this link to allow it: ${needed.authorizationUrl}`,
        )
      }).pipe(Effect.catchCause(() => Effect.logWarning("mcp: the authorization link could not be sent"))),
  }
}

// Top of the stack: the channels exist, so the slot is pointed at them.
export const McpNotifyBindLive: Layer.Layer<
  never,
  never,
  McpNotifySlot | SqlClient | Beacon | TelegramOut | TelegramStatus
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const slot = yield* McpNotifySlot
    const status = yield* TelegramStatus
    const notifier = makeOAuthNotifier({
      sql: yield* SqlClient,
      beacon: yield* Beacon,
      telegram: yield* TelegramOut,
      telegramOn: status.enabled,
    })
    slot.bind(notifier.notify)
  }),
)

// One warning at boot: remote servers that need OAuth exist, but the tokens have no key to be sealed with.
const warnOauthOff = Effect.gen(function* () {
  const sql = yield* SqlClient
  const rows = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM mcp_servers
    WHERE enabled = 1 AND json_extract(auth, '$.kind') = 'oauth'`
  if ((rows[0]?.n ?? 0) > 0)
    yield* Effect.logWarning(
      "mcp: servers that need OAuth are registered but VAULT_KEY is not set; they stay unavailable",
    )
}).pipe(Effect.catchCause(() => Effect.void))

// The registry of the product: secrets from the Vault by Bot, calls judged by the Policy, OAuth tokens sealed with the
// Vault key. Without VAULT_KEY the OAuth side is off and a remote server with auth oauth cannot be reached.
export const McpRegistryFromCore = (config: Pick<AppConfigShape, "vaultKey" | "appUrl" | "port">) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const vault = yield* Vault
      const policy = yield* Policy
      const slot = yield* McpNotifySlot
      if (Option.isNone(config.vaultKey)) yield* warnOauthOff
      const store = Option.isSome(config.vaultKey)
        ? yield* makeSqlOAuthStore(vaultCipher(Redacted.value(config.vaultKey.value)))
        : undefined
      return McpRegistryLive({
        secretsOf: vaultSecrets(vault),
        gate: { evaluate: (botId, call) => policy.evaluate(botId, call) },
        ...(store === undefined
          ? {}
          : {
              oauth: {
                store,
                redirectUrl: `${coreApiOrigin(config.appUrl, config.port)}${MCP_OAUTH_CALLBACK_PATH}`,
                notify: slot.notify,
              },
            }),
      })
    }),
  )

// The Bot's servers for CLI runs and the tools of the chat-completions loop, both read from the registry.
const RunLayers = (oauthAvailable: boolean) =>
  Layer.mergeAll(
    Layer.effect(
      BotMcp,
      Effect.gen(function* () {
        return makeBotMcp({
          registry: yield* McpRegistry,
          vault: yield* Vault,
          beacon: yield* Beacon,
          oauthAvailable,
        })
      }),
    ),
    Layer.effect(
      McpToolHosts,
      Effect.gen(function* () {
        return makeMcpToolHosts({ registry: yield* McpRegistry })
      }),
    ),
  )

// Everything MCP that sits below the Lead: the Vault, the registry, the notify slot and the two run-side services.
export const McpFromCore = (config: Pick<AppConfigShape, "vaultFile" | "vaultKey" | "appUrl" | "port">) =>
  RunLayers(Option.isSome(config.vaultKey)).pipe(
    Layer.provideMerge(McpRegistryFromCore(config)),
    Layer.provideMerge(Layer.mergeAll(McpNotifySlotLive, VaultFromConfig(config))),
  )
