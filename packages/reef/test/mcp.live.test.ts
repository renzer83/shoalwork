import { spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

// Needs the real claude CLI, a logged-in account and a running core API. Runs only with LIVE=1 and
// SHOALWORK_API_TOKEN + REEF_LIVE_API (origin of the core) set. Not part of the default gate (R11).
const live = process.env.LIVE === "1"
const apiToken = process.env.SHOALWORK_API_TOKEN ?? ""
const liveApi = process.env.REEF_LIVE_API ?? ""

const runClaude = (args: ReadonlyArray<string>, env: Record<string, string>): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn("claude", [...args], { env, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8")
    })
    child.on("error", reject)
    child.on("close", () => resolve(stdout))
  })

describe.skipIf(!live)("reef MCP live", () => {
  it("claude calls the reef search_code tool through --mcp-config", { timeout: 180_000 }, async () => {
    expect(apiToken).not.toBe("")
    expect(liveApi).not.toBe("")
    const home = await mkdtemp(join(tmpdir(), "reef-mcp-live-"))
    try {
      const entry = fileURLToPath(new URL("../dist/mcp.js", import.meta.url))
      const configFile = join(home, "mcp.json")
      await writeFile(
        configFile,
        JSON.stringify({
          mcpServers: {
            reef: {
              command: "node",
              args: [entry, "--repo", "shoalwork", "--bot", "bot_live", "--api", liveApi],
              // biome-ignore lint/suspicious/noTemplateCurlyInString: the CLI expands this reference at launch
              env: { SHOALWORK_API_TOKEN: "${SHOALWORK_API_TOKEN}" },
            },
          },
        }),
        { mode: 0o600 },
      )
      const stdout = await runClaude(
        [
          "-p",
          "--output-format",
          "stream-json",
          "--verbose",
          "--max-turns",
          "4",
          "--model",
          "claude-haiku-5-5",
          "--strict-mcp-config",
          "--mcp-config",
          configFile,
          "--allowedTools",
          "mcp__reef__search_code",
          "--",
          "use search_code to find the function that builds the MCP config",
        ],
        {
          HOME: home,
          CLAUDE_CONFIG_DIR: join(home, ".claude"),
          PATH: process.env.PATH ?? "",
          USER: process.env.USER ?? "",
          SHOALWORK_API_TOKEN: apiToken,
        },
      )
      expect(stdout).toContain('"name":"mcp__reef__search_code"')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
