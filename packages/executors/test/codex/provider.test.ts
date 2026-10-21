import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { BotId } from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import { afterAll, describe, expect } from "vitest"
import { mergeMcpTable, reefTomlBlock } from "../../src/codex/args.js"
import {
  type CodexProvider,
  CodexProvider as CodexProviderSchema,
  mergeCodexProvider,
  writeCodexProviderConfig,
} from "../../src/codex/provider.js"
import type { ExecutorContext } from "../../src/executor.js"
import {
  codexServerBlock,
  MANAGED_BEGIN,
  MANAGED_END,
  stripManagedServers,
  withManagedServers,
} from "../../src/mcp-inject.js"

const provider: CodexProvider = Schema.decodeUnknownSync(CodexProviderSchema)({
  name: "local_ollama",
  base_url: "http://localhost:11434/v1",
  wire_api: "responses",
})

const BOT_SERVER = {
  name: "github",
  transport: "stdio" as const,
  command: "gh-mcp",
  args: ["--read-only"],
  envKeys: ["GH_TOKEN"],
  allowedTools: ["list_prs"],
}

// A config.toml as the codex CLI and the MCP writer leave it: user keys, a project table, the reef table and the
// managed region of the Bot's own servers.
const withMcp = (): string => {
  const reef = reefTomlBlock(["/srv/reef.js", "--repo", "r"], "node", "SHOALWORK_API_TOKEN")
  const base = `model = "gpt-5.5"\nmodel_reasoning_effort = "high"\n\n[projects."/work"]\ntrust_level = "trusted"\n`
  const merged = mergeMcpTable(stripManagedServers(base), reef)
  return withManagedServers(merged, codexServerBlock([BOT_SERVER]))
}

const count = (text: string, needle: string): number => text.split(needle).length - 1

describe("codex provider config", () => {
  it("validates the provider shape and rejects a wire_api other than responses", () => {
    expect(() =>
      Schema.decodeUnknownSync(CodexProviderSchema)({
        name: "local_ollama",
        base_url: "http://localhost:11434/v1",
        wire_api: "chat",
      }),
    ).toThrow()
    expect(
      Schema.decodeUnknownSync(CodexProviderSchema)({
        name: "local_ollama",
        base_url: "http://localhost:11434/v1",
        wire_api: "responses",
      }),
    ).toEqual(provider)
  })

  it("adds model_provider at the top and the provider table, keeping every existing key", () => {
    const merged = mergeCodexProvider(withMcp(), provider)
    expect(merged.startsWith('model_provider = "local_ollama"\n')).toBe(true)
    expect(merged).toContain('model = "gpt-5.5"')
    expect(merged).toContain('model_reasoning_effort = "high"')
    expect(merged).toContain('[projects."/work"]')
    expect(merged).toContain("[mcp_servers.reef]")
    expect(merged).toContain(MANAGED_BEGIN)
    expect(merged).toContain(MANAGED_END)
    expect(merged).toContain("[mcp_servers.github]")
    expect(merged).toContain(
      '[model_providers.local_ollama]\nname = "local_ollama"\nbase_url = "http://localhost:11434/v1"\nwire_api = "responses"',
    )
  })

  it("is idempotent: merging its own output again gives the same text", () => {
    const once = mergeCodexProvider(withMcp(), provider)
    expect(mergeCodexProvider(once, provider)).toBe(once)
    expect(count(once, "[model_providers.local_ollama]")).toBe(1)
    expect(count(once, 'model_provider = "local_ollama"')).toBe(1)
  })

  it("replaces an older model_provider value and an older provider table", () => {
    const stale = `model_provider = "openai"\n\n[model_providers.local_ollama]\nname = "old"\nbase_url = "http://old/v1"\nwire_api = "responses"\n`
    const merged = mergeCodexProvider(stale, provider)
    expect(count(merged, "model_provider =")).toBe(1)
    expect(merged).not.toContain("http://old/v1")
    expect(count(merged, "[model_providers.local_ollama]")).toBe(1)
  })

  it("keeps the managed MCP region intact when the provider table was written after it", () => {
    const first = mergeCodexProvider(withMcp(), provider)
    // A later MCP write strips its region and appends it again after the provider table.
    const mcpAgain = withManagedServers(
      mergeMcpTable(
        stripManagedServers(first),
        reefTomlBlock(["/srv/reef.js"], "node", "SHOALWORK_API_TOKEN"),
      ),
      codexServerBlock([BOT_SERVER]),
    )
    const merged = mergeCodexProvider(mcpAgain, provider)
    expect(count(merged, MANAGED_BEGIN)).toBe(1)
    expect(count(merged, MANAGED_END)).toBe(1)
    expect(count(merged, "[mcp_servers.github]")).toBe(1)
    expect(count(merged, "[mcp_servers.reef]")).toBe(1)
    expect(count(merged, "[model_providers.local_ollama]")).toBe(1)
  })

  it("keeps a file with no tables and no keys as the provider alone", () => {
    expect(mergeCodexProvider("", provider)).toContain('model_provider = "local_ollama"')
  })
})

describe("writeCodexProviderConfig", () => {
  const dirs: Array<string> = []
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })

  const bot = Schema.decodeUnknownSync(BotId)("bot_00000000-0000-4000-8000-000000000001")

  it.effect("writes into the Bot's CODEX_HOME and keeps the existing keys of its config.toml", () =>
    Effect.gen(function* () {
      const home = mkdtempSync(join(tmpdir(), "codex-provider-"))
      dirs.push(home)
      const codexHome = join(home, ".codex")
      mkdirSync(codexHome, { recursive: true })
      writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n')
      const ctx: ExecutorContext = {
        botId: bot,
        botName: "bot-a",
        cwd: home,
        home,
        env: { HOME: home, CODEX_HOME: codexHome },
      }
      const path = yield* writeCodexProviderConfig(ctx, provider)
      expect(path).toBe(join(codexHome, "config.toml"))
      const text = readFileSync(path, "utf8")
      expect(text.startsWith('model_provider = "local_ollama"\n')).toBe(true)
      expect(text).toContain('model = "gpt-5.5"')
      expect(text).toContain("[model_providers.local_ollama]")
    }),
  )
})
