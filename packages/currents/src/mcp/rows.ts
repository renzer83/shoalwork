import { SchemaViolation } from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import { AllowedTools, McpServer } from "./types.js"

export interface ServerRow {
  readonly id: string
  readonly name: string
  readonly transport: string
  readonly command: string | null
  readonly args: string
  readonly env_keys: string
  readonly url: string | null
  readonly auth: string
  readonly enabled: number
  readonly created_at: string
}

export interface BotServerRow extends ServerRow {
  readonly allowed_tools: string
}

const parse = (text: string): Effect.Effect<unknown, SchemaViolation> =>
  Effect.try({
    try: (): unknown => JSON.parse(text),
    catch: (issue) => new SchemaViolation({ where: "mcp_servers", issue }),
  })

// Rows were written by this registry, so a row that no longer decodes is a defect, not a user error.
export const decodeServer = (row: ServerRow): Effect.Effect<McpServer> =>
  Effect.gen(function* () {
    const base = {
      id: row.id,
      name: row.name,
      transport: row.transport,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
    }
    const raw =
      row.transport === "stdio"
        ? {
            ...base,
            command: row.command ?? "",
            args: yield* parse(row.args),
            envKeys: yield* parse(row.env_keys),
          }
        : { ...base, url: row.url ?? "", auth: yield* parse(row.auth) }
    return yield* Schema.decodeUnknownEffect(McpServer)(raw)
  }).pipe(Effect.orDie)

export const decodeAllowed = (text: string): Effect.Effect<AllowedTools> =>
  parse(text).pipe(
    Effect.flatMap((raw) => Schema.decodeUnknownEffect(AllowedTools)(raw)),
    Effect.orDie,
  )
