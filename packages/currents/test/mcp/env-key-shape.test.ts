import { it } from "@effect/vitest"
import { SchemaViolation } from "@shoalwork/contracts"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { isMcpSecretEnvName } from "../../src/mcp/index.js"
import { gateSaying, layerWith, McpRegistry, secretsFake, stdioServer } from "./support.js"

const ACCEPTED = [
  "GITHUB_TOKEN",
  "NOTION_API_KEY",
  "SLACK_BOT_TOKEN",
  "DB_PASSWORD",
  "GH_PAT",
  "WEBHOOK_SECRET",
  "MCP_ANYTHING",
]
const REFUSED: Record<string, ReadonlyArray<string>> = {
  "process and loader": ["PATH", "HOME", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "NODE_OPTIONS", "SHELL"],
  "language runtimes": ["PYTHONHOME", "RUBYOPT", "PERL5OPT", "JAVA_TOOL_OPTIONS", "SHELLOPTS", "PS4"],
  "desktop, ssh and tls": [
    "XDG_CONFIG_HOME",
    "SSH_AUTH_SOCK",
    "SSL_CERT_DIR",
    "CURL_CA_BUNDLE",
    "REQUESTS_CA_BUNDLE",
  ],
  "proxy and package managers": ["HTTPS_PROXY", "NO_PROXY", "NPM_CONFIG_REGISTRY", "NPM_CONFIG_TOKEN"],
  "executor credentials (ADR-011)": [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "ZAI_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CODEX_API_KEY",
    "GIT_ASKPASS",
    "SHOALWORK_API_TOKEN",
  ],
  "the alias namespace": ["MCP_SECRET_0"],
  shape: ["", "A", "lower_token", "1_TOKEN", "BAD-NAME_TOKEN", "TOKEN", "NOTES"],
}

describe("env names a server may ask for", () => {
  it("accepts names that look like a secret", () => {
    for (const name of ACCEPTED) expect(isMcpSecretEnvName(name), name).toBe(true)
  })

  for (const [family, names] of Object.entries(REFUSED)) {
    it(`refuses ${family}`, () => {
      for (const name of names) expect(isMcpSecretEnvName(name), name).toBe(false)
    })
  }

  it.effect("the registry refuses such a name at upsert, before any run", () =>
    Effect.gen(function* () {
      const registry = yield* McpRegistry
      const bad = yield* Effect.flip(registry.upsert(stdioServer("fake", ["NODE_OPTIONS"])))
      expect(bad).toBeInstanceOf(SchemaViolation)
      const viaBearer = yield* Effect.flip(
        registry.upsert({
          name: "remote",
          transport: "http",
          url: "https://mcp.example/mcp",
          auth: { kind: "bearer", tokenKey: "HTTPS_PROXY" },
        }),
      )
      expect(viaBearer).toBeInstanceOf(SchemaViolation)
      expect((yield* registry.upsert(stdioServer("fake", ["FAKE_SECRET"]))).name).toBe("fake")
    }).pipe(Effect.provide(layerWith({ secretsOf: secretsFake({}), gate: gateSaying("allow").gate }))),
  )
})
