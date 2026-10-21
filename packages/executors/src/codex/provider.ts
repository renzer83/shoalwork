import { mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import type { ExecutorContext } from "../executor.js"
import { assertNoLink, McpConfigError, writeSecureFile } from "../mcp-config.js"
import { MANAGED_BEGIN, MANAGED_END } from "../mcp-inject.js"

// A model provider served by a local or third-party endpoint that speaks the OpenAI Responses API (codex wire_api).
// `name` is the TOML table key (model_providers.<name>) and the display name.
export const CodexProvider = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/)),
  base_url: Schema.String.check(Schema.isPattern(/^https?:\/\/[^\s"]+$/)),
  wire_api: Schema.Literal("responses"),
})
export type CodexProvider = typeof CodexProvider.Type

const TABLE_HEADER = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/
const MODEL_PROVIDER_KEY = /^\s*model_provider\s*=/

const quote = (text: string): string => JSON.stringify(text)

const isProviderTable = (name: string, provider: string): boolean => {
  const normalized = name.replace(/["'\s]/g, "")
  const table = `model_providers.${provider}`
  return normalized === table || normalized.startsWith(`${table}.`)
}

// Same tables as codex reads for one provider. Pure: text in, text out.
export const codexProviderTable = (provider: CodexProvider): string =>
  [
    `[model_providers.${provider.name}]`,
    `name = ${quote(provider.name)}`,
    `base_url = ${quote(provider.base_url)}`,
    `wire_api = ${quote(provider.wire_api)}`,
    "",
  ].join("\n")

// Sets model_provider at the top level and replaces the provider's own table. Every other line stays as it is, the
// reef table and the managed MCP region included. Running it on its own output gives the same text.
export const mergeCodexProvider = (existing: string, provider: CodexProvider): string => {
  const lines = existing.split("\n")
  const firstTable = lines.findIndex((line) => TABLE_HEADER.test(line))
  const headEnd = firstTable === -1 ? lines.length : firstTable
  // Top-level keys must come before the first table header, or TOML reads them as part of that table.
  const head = lines.slice(0, headEnd).filter((line) => !MODEL_PROVIDER_KEY.test(line))
  const kept: Array<string> = []
  let inProvider = false
  for (const line of lines.slice(headEnd)) {
    const header = TABLE_HEADER.exec(line)
    if (header !== null) inProvider = isProviderTable(header[1] ?? "", provider.name)
    // A managed marker ends the provider table: the region after it belongs to the MCP writer.
    if (line.trim() === MANAGED_BEGIN || line.trim() === MANAGED_END) inProvider = false
    if (!inProvider) kept.push(line)
  }
  const top = `model_provider = ${quote(provider.name)}`
  return [top, head.join("\n").trim(), kept.join("\n").trim(), codexProviderTable(provider).trimEnd()]
    .filter((part) => part !== "")
    .join("\n\n")
    .concat("\n")
}

// Writes the provider into the Bot's own CODEX_HOME/config.toml (never the operator's HOME). Returns the path.
export const writeCodexProviderConfig = (
  ctx: ExecutorContext,
  provider: CodexProvider,
): Effect.Effect<string, McpConfigError> =>
  Effect.tryPromise({
    try: async () => {
      const codexHome = ctx.env.CODEX_HOME ?? join(ctx.home, ".codex")
      const path = join(codexHome, "config.toml")
      await mkdir(codexHome, { recursive: true })
      await assertNoLink(codexHome)
      await assertNoLink(path)
      const existing = await readFile(path, "utf8").catch((cause: unknown) => {
        if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT")
          return ""
        throw cause
      })
      await writeSecureFile(codexHome, path, mergeCodexProvider(existing, provider))
      return path
    },
    catch: (cause) => new McpConfigError({ executor: "codex", reason: "cannot write config.toml", cause }),
  })
