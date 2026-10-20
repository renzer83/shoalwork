import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import { PROBE_LOG_ENV, PROBE_VARIANT_ENV, PROBE_VARIANTS } from "../../src/permission-bridge/probe.js"
import { buildPackage, cliVersion, distDir, live, liveEnv, packageRoot } from "./live-support.js"

// T-055 step 1: learn the real contract of --permission-prompt-tool. Writes test/fixtures/permission-bridge/
// probe-<cli version>.json with what the CLI sent and which response shape it accepted.
describe.skipIf(!live)("permission probe live", () => {
  beforeAll(buildPackage, 180_000)

  it("records the request and finds the accepted response shape", () => {
    const version = cliVersion()
    const results: Record<string, unknown> = {}
    for (const variant of PROBE_VARIANTS) {
      const workdir = mkdtempSync(join(tmpdir(), "probe-"))
      try {
        const logPath = join(workdir, "probe.log")
        const config = join(workdir, "mcp.json")
        writeFileSync(
          config,
          JSON.stringify({
            mcpServers: {
              "permission-bridge": {
                command: process.execPath,
                args: [join(distDir, "probe.js")],
                env: { [PROBE_LOG_ENV]: logPath, [PROBE_VARIANT_ENV]: variant },
              },
            },
          }),
        )
        const run = spawnSync(
          "claude",
          [
            "-p",
            "--output-format",
            "stream-json",
            "--verbose",
            "--permission-mode",
            "default",
            "--permission-prompt-tool",
            "mcp__permission-bridge__approve",
            "--max-turns",
            "3",
            "--model",
            "claude-haiku-5-5",
            "--strict-mcp-config",
            "--mcp-config",
            config,
            "--",
            "create a file probe.txt with the text ok",
          ],
          { cwd: workdir, env: liveEnv(), encoding: "utf8", timeout: 120_000 },
        )
        const lines = (existsSync(logPath) ? readFileSync(logPath, "utf8") : "").split("\n").filter(Boolean)
        const last = run.stdout.trim().split("\n").at(-1) ?? "{}"
        const result = JSON.parse(last) as { subtype?: string; permission_denials?: unknown }
        results[variant] = {
          received: lines.map((line) => (JSON.parse(line) as { args: unknown }).args),
          fileCreated: existsSync(join(workdir, "probe.txt")),
          resultSubtype: result.subtype,
          permissionDenials: result.permission_denials,
        }
      } finally {
        rmSync(workdir, { recursive: true, force: true })
      }
    }
    const dir = join(packageRoot, "test", "fixtures", "permission-bridge")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `probe-${version}.json`),
      `${JSON.stringify({ cliVersion: version, results }, null, 2)}\n`,
    )
    const allow = results.allow as {
      received: Array<{ tool_name?: string; input?: unknown }>
      fileCreated: boolean
    }
    expect(allow.received.length).toBeGreaterThan(0)
    expect(allow.received[0]?.tool_name).toBeTypeOf("string")
    expect(allow.received[0]?.input).toBeTypeOf("object")
    expect(allow.fileCreated).toBe(true)
    expect((results.deny as { fileCreated: boolean }).fileCreated).toBe(false)
  }, 600_000)
})
