import { execFileSync, spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import { buildPackage, distDir, live, liveEnv } from "./live-support.js"

// T-055 end to end against the real CLI: a `git push` is held for 3 minutes on the permission tool, the fake core then
// approves, and the CLI goes on and finishes. Runs only with LIVE=1 (and takes about 4 minutes).
const APPROVAL = "apr_0b9c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d"
const PAUSE_MS = 180_000
const TOKEN = ["mcp", "e2e", "token", "for", "tests"].join("_")

const git = (cwd: string, ...args: Array<string>): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: liveEnv() }).trim()

describe.skipIf(!live)("permission bridge e2e live", () => {
  beforeAll(buildPackage, 180_000)

  it("holds a git push for 3 minutes, then continues without repeating it", async () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-e2e-"))
    const remote = join(root, "remote.git")
    const work = join(root, "work")
    git(root, "init", "--bare", remote)
    git(root, "init", work)
    git(work, "-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "--allow-empty", "-m", "init")
    git(work, "remote", "add", "origin", remote)

    let askedAt = 0
    const pushEvaluations: Array<string> = []
    const core = createServer((req, res) => {
      const chunks: Array<Buffer> = []
      req.on("data", (chunk: Buffer) => chunks.push(chunk))
      req.on("end", () => {
        res.setHeader("content-type", "application/json")
        if (req.url === "/policy/evaluate") {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { input?: { command?: string } }
          const isPush = body.input?.command?.includes("git push") === true
          if (!isPush) return void res.end(JSON.stringify({ effect: "allow" }))
          if (askedAt === 0) {
            askedAt = Date.now()
            pushEvaluations.push("ask")
            return void res.end(JSON.stringify({ effect: "ask", approvalId: APPROVAL }))
          }
          const granted = Date.now() >= askedAt + PAUSE_MS
          pushEvaluations.push(granted ? "allow" : "ask")
          return void res.end(
            JSON.stringify(granted ? { effect: "allow" } : { effect: "ask", approvalId: APPROVAL }),
          )
        }
        const wait = Math.max(0, Math.min(60_000, askedAt + PAUSE_MS - Date.now()))
        setTimeout(() => res.end(JSON.stringify({ status: wait === 0 ? "approved" : "pending" })), wait)
      })
    })
    await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", () => resolve()))
    const address = core.address()
    if (address === null || typeof address === "string") throw new Error("fake core did not bind")
    const config = join(root, "mcp.json")
    writeFileSync(
      config,
      JSON.stringify({
        mcpServers: {
          "permission-bridge": {
            command: process.execPath,
            args: [join(distDir, "index.js"), "--api", `http://127.0.0.1:${address.port}`],
            env: { SHOALWORK_API_TOKEN: TOKEN },
          },
        },
      }),
    )
    try {
      const started = Date.now()
      const child = spawn(
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
          "6",
          "--model",
          "claude-haiku-5-5",
          "--strict-mcp-config",
          "--mcp-config",
          config,
          "--",
          "Run exactly this command and nothing else: git push origin HEAD",
        ],
        { cwd: work, env: liveEnv() },
      )
      child.stdin.end()
      let stdout = ""
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8")
      })
      await new Promise<void>((resolve) => child.on("close", () => resolve()))
      const elapsed = Date.now() - started
      const lines = stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; subtype?: string; message?: unknown })
      const result = lines.at(-1)
      expect(result?.subtype).toBe("success")
      expect(elapsed).toBeGreaterThanOrEqual(PAUSE_MS)
      // Only tool_use blocks count: the assistant may quote the command in its text.
      const pushRuns = lines
        .filter((line) => line.type === "assistant")
        .flatMap(
          (line) => JSON.stringify(line.message).match(/"type":"tool_use"[^}]*git push origin HEAD/g) ?? [],
        )
      expect(pushRuns).toHaveLength(1)
      expect(pushEvaluations.at(-1)).toBe("allow")
      expect(git(remote, "rev-parse", "HEAD")).toBe(git(work, "rev-parse", "HEAD"))
    } finally {
      core.close()
      rmSync(root, { recursive: true, force: true })
    }
  }, 900_000)
})
