import { randomUUID } from "node:crypto"
import type { BeaconShape } from "@shoalwork/beacon"
import type { Bot, BotId, TaskSpec } from "@shoalwork/contracts"
import { streamIds } from "@shoalwork/contracts"
import {
  isMcpSecretEnvName,
  type McpRegistryShape,
  type McpServerForBot,
  parseQualifiedToolName,
  qualifiedToolName,
  toolAllowed,
} from "@shoalwork/currents"
import type { McpInject, McpToolHost } from "@shoalwork/executors"
import { isInjectable } from "@shoalwork/executors"
import type { BotMcpGrant, BotMcpShape } from "@shoalwork/lead"
import type { VaultShape } from "@shoalwork/vault"
import { Effect, type Redacted } from "effect"
import { mcpEnvSources, toMcpInject } from "./mcp-inject-adapter.js"

type Refusal =
  | "list_tools_failed"
  | "secret_missing"
  | "auth_required"
  | "oauth_unavailable"
  | "not_injectable"

type Secret = { readonly env: string; readonly value: Redacted.Redacted<string> }

// One server of a Bot for one run: handed over (with the secrets it needs, by the name the server reads) or refused.
type Verdict =
  | { readonly kind: "attached"; readonly inject: McpInject; readonly secrets: ReadonlyArray<Secret> }
  | { readonly kind: "refused"; readonly reason: Refusal }

export interface BotMcpDeps {
  readonly registry: McpRegistryShape
  readonly vault: VaultShape
  readonly beacon: BeaconShape
  // False without VAULT_KEY: a server that needs OAuth is refused with its own reason, not as a missing authorization.
  readonly oauthAvailable?: boolean
  // How long a server has to list its tools before a run starts without it.
  readonly listTimeoutMs?: number
}

const LIST_TIMEOUT_MS = 10_000
const refused = (reason: Refusal): Verdict => ({ kind: "refused", reason })

// Names and tools only (R7): the record of what a CLI run could call, since the CLI's own MCP calls never pass through
// the registry and so have no mcp.called.
const recordAttach = (
  beacon: BeaconShape,
  botId: BotId,
  taskId: string,
  server: string,
  outcome: Verdict,
  allowed: McpServerForBot["allowedTools"],
) =>
  beacon
    .append({
      streamId: streamIds.bot(botId),
      type: "mcp.server_changed",
      payload:
        outcome.kind === "attached"
          ? { action: "attached", server, botId, taskId, tools: allowed === "*" ? ["*"] : [...allowed] }
          : { action: "attach_refused", server, botId, taskId, reason: outcome.reason },
      actor: "system:mcp",
      correlationId: randomUUID(),
    })
    .pipe(
      Effect.asVoid,
      Effect.catchCause(() => Effect.logWarning("mcp: could not record the attachment")),
    )

type ToolNames = (server: McpServerForBot) => Effect.Effect<ReadonlyArray<string> | undefined>

const judgeServer = (
  deps: BotMcpDeps,
  botId: BotId,
  server: McpServerForBot,
  toolNames: ToolNames,
): Effect.Effect<Verdict | undefined> =>
  Effect.gen(function* () {
    // A Bot with an empty list has no access: nothing to attach, nothing to say.
    if (server.allowedTools !== "*" && server.allowedTools.length === 0) return undefined
    if (server.transport === "http" && server.auth.kind === "oauth" && deps.oauthAvailable === false)
      return refused("oauth_unavailable")
    // Fail closed: with an explicit list the others are denied to the CLI by name, which needs every tool the server has.
    // If the server cannot say what it has, it is not given at all.
    let known: ReadonlyArray<string> | undefined
    if (server.allowedTools !== "*") {
      known = yield* toolNames(server)
      if (known === undefined) return refused("list_tools_failed")
    }
    const inject = toMcpInject(server, known)
    if (inject === undefined || !isInjectable(inject)) return refused("not_injectable")
    const secrets: Array<Secret> = []
    for (const source of mcpEnvSources([server])) {
      // The Vault key is also the name the server reads: only names that look like a secret (registry rule) are passed.
      if (!isMcpSecretEnvName(source.env)) return refused("not_injectable")
      if ("vaultKey" in source) {
        const value = yield* deps.vault.get(botId, source.vaultKey).pipe(Effect.result)
        if (value._tag === "Failure") return refused("secret_missing")
        secrets.push({ env: source.env, value: value.success })
      } else {
        const token = yield* deps.registry.accessToken(source.oauthServer)
        if (token === undefined) return refused("auth_required")
        secrets.push({ env: source.env, value: token })
      }
    }
    return { kind: "attached", inject, secrets } satisfies Verdict
  })

// Every secret travels as MCP_SECRET_<n> (the one name the Tank passes and sudo keeps); the server's config maps it back.
const aliased = (inject: McpInject, secrets: ReadonlyArray<Secret>, first: number) => {
  const refs: Record<string, string> = {}
  const env: Record<string, Redacted.Redacted<string>> = {}
  secrets.forEach((secret, index) => {
    const ref = `MCP_SECRET_${first + index}`
    refs[secret.env] = ref
    env[ref] = secret.value
  })
  const mapped: McpInject =
    inject.transport === "stdio"
      ? { ...inject, envRefs: refs }
      : { ...inject, ...(inject.bearerEnv === undefined ? {} : { bearerEnv: refs[inject.bearerEnv] }) }
  return { inject: mapped, env }
}

// The Bot's own MCP servers for a CLI run (claude-code, codex). Values of the Vault keys go only into `secretEnv`, which the
// Tank puts in the executor process env.
export const makeBotMcp = (deps: BotMcpDeps): BotMcpShape => {
  // The tools a server listed for a task, kept for its retries and rounds (a run is a few seconds, a task can be many).
  const listed = new Map<string, ReadonlyArray<string>>()
  const timeout = deps.listTimeoutMs ?? LIST_TIMEOUT_MS
  const namesFor =
    (botId: BotId, taskId: string): ToolNames =>
    (server) => {
      const key = `${taskId}:${server.id}`
      const cached = listed.get(key)
      if (cached !== undefined) return Effect.succeed(cached)
      return deps.registry.test(server.id, botId).pipe(
        Effect.timeout(timeout),
        Effect.map((result) => result.tools.map((tool) => tool.name)),
        Effect.tap((names) =>
          Effect.sync(() => {
            if (listed.size > 256) listed.clear()
            listed.set(key, names)
          }),
        ),
        Effect.catchCause(() => Effect.succeed(undefined)),
      )
    }
  return {
    resolve: (bot: Bot, spec: Pick<TaskSpec, "id" | "botId">) =>
      Effect.gen(function* () {
        const servers = yield* deps.registry.forBot(bot.id)
        // Servers start and answer in parallel; the verdicts are read in the registry's order.
        const verdicts = yield* Effect.forEach(
          servers,
          (server) => judgeServer(deps, bot.id, server, namesFor(bot.id, spec.id)),
          { concurrency: 4 },
        )
        const injects: Array<McpInject> = []
        const secretEnv: Record<string, Redacted.Redacted<string>> = {}
        let used = 0
        for (const [index, server] of servers.entries()) {
          const verdict = verdicts[index]
          if (verdict === undefined) continue
          yield* recordAttach(deps.beacon, bot.id, spec.id, server.name, verdict, server.allowedTools)
          if (verdict.kind !== "attached") continue
          const mapped = aliased(verdict.inject, verdict.secrets, used)
          used += verdict.secrets.length
          injects.push(mapped.inject)
          Object.assign(secretEnv, mapped.env)
        }
        return injects.length === 0 ? undefined : ({ servers: injects, secretEnv } satisfies BotMcpGrant)
      }).pipe(
        Effect.catchCause(() =>
          Effect.logWarning("mcp: the Bot's servers could not be resolved").pipe(Effect.as(undefined)),
        ),
      ),
  }
}

// openai-compat accepts function names of this shape only.
const FUNCTION_NAME = /^[A-Za-z0-9_-]{1,64}$/
const FALLBACK_SCHEMA: Readonly<Record<string, unknown>> = { type: "object", properties: {} }
const CALL_ERROR_MAX = 300

const textOf = (result: unknown): { readonly text: string; readonly isError: boolean } => {
  if (
    typeof result !== "object" ||
    result === null ||
    !("content" in result) ||
    !Array.isArray(result.content)
  )
    return { text: "", isError: false }
  const blocks: ReadonlyArray<unknown> = result.content
  const text = blocks
    .map((block) =>
      typeof block === "object" && block !== null && "text" in block && typeof block.text === "string"
        ? block.text
        : "[non-text content omitted]",
    )
    .join("\n")
  return { text, isError: "isError" in result && result.isError === true }
}

// The tools of the Bot's servers for the chat-completions loop: names `mcp__<server>__<tool>`, the Bot's tool list applied.
// A server that cannot list is left out (its tools are never offered). The loop judges the call with the Policy first, so
// the registry is asked with policyChecked.
export const makeMcpToolHosts = (deps: Pick<BotMcpDeps, "registry">) => ({
  forBot: (botId: BotId): Effect.Effect<McpToolHost | undefined> =>
    Effect.gen(function* () {
      const servers = yield* deps.registry.forBot(botId)
      const tools: Array<McpToolHost["tools"][number]> = []
      for (const server of servers) {
        if (server.allowedTools !== "*" && server.allowedTools.length === 0) continue
        const listed = yield* deps.registry.test(server.id, botId).pipe(Effect.result)
        if (listed._tag === "Failure") continue
        for (const tool of listed.success.tools) {
          const name = qualifiedToolName(server.name, tool.name)
          if (!toolAllowed(server.allowedTools, tool.name) || !FUNCTION_NAME.test(name)) continue
          tools.push({
            name,
            parameters: tool.inputSchema ?? FALLBACK_SCHEMA,
            ...(tool.description === undefined ? {} : { description: tool.description }),
          })
        }
      }
      if (tools.length === 0) return undefined
      const host: McpToolHost = {
        tools,
        call: (calling, name, args) => {
          const parsed = parseQualifiedToolName(name)
          if (parsed === undefined) return Effect.fail("not an MCP tool")
          return deps.registry.call(calling, parsed.server, parsed.tool, args, { policyChecked: true }).pipe(
            Effect.mapError((error) =>
              `${error._tag}: ${"message" in error ? error.message : "denied"}`.slice(0, CALL_ERROR_MAX),
            ),
            Effect.flatMap((result) => {
              const out = textOf(result)
              return out.isError ? Effect.fail(out.text.slice(0, CALL_ERROR_MAX)) : Effect.succeed(out.text)
            }),
          )
        },
      }
      return host
    }).pipe(Effect.catchCause(() => Effect.succeed(undefined))),
})
