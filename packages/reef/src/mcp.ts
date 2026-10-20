#!/usr/bin/env node
// stdio entrypoint of the reef MCP server (bin app-reef-mcp). stdout is the MCP protocol: nothing else is written
// there while serving. Diagnostics go to stderr, redacted.
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { serveStdio } from "@modelcontextprotocol/server/stdio"
import { Redacted } from "effect"
import { makeReefApi } from "./mcp/api.js"
import { makeReefMcpServer } from "./mcp/server.js"

export const MCP_TOKEN_ENV = "SHOALWORK_API_TOKEN"

export const USAGE = [
  "usage: app-reef-mcp --repo <name> --bot <botId> --api <url>",
  "",
  "  --repo <name>   repository whose index search_code queries",
  "  --bot <botId>   Bot whose memory search_memory queries",
  "  --api <url>     origin of the core API (http or https)",
  "",
  `The core token is read from the ${MCP_TOKEN_ENV} environment variable (never from argv).`,
  "",
].join("\n")

export type McpArgs =
  | { readonly kind: "help" }
  | { readonly kind: "run"; readonly repo: string; readonly bot: string; readonly api: string }
  | { readonly kind: "error"; readonly message: string }

const VALUE_FLAGS: ReadonlySet<string> = new Set(["--repo", "--bot", "--api"])

// Pure: argv in, decision out. Tokens in argv would be visible to other users of the host, so --token is refused.
export const parseMcpArgs = (argv: ReadonlyArray<string>): McpArgs => {
  const values: Record<string, string> = {}
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? ""
    if (flag === "--help" || flag === "-h") return { kind: "help" }
    if (flag === "--token" || flag.startsWith("--token=")) {
      return { kind: "error", message: `--token is not accepted; set ${MCP_TOKEN_ENV} instead` }
    }
    if (!VALUE_FLAGS.has(flag)) return { kind: "error", message: `unknown argument: ${flag.slice(0, 64)}` }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith("--")) {
      return { kind: "error", message: `${flag} needs a value` }
    }
    values[flag] = value
    index += 1
  }
  const repo = values["--repo"]
  const bot = values["--bot"]
  const api = values["--api"]
  if (repo === undefined || bot === undefined || api === undefined) {
    return { kind: "error", message: "--repo, --bot and --api are required" }
  }
  if (repo.trim() === "" || bot.trim() === "") {
    return { kind: "error", message: "--repo and --bot must not be empty" }
  }
  const origin = parseOrigin(api)
  if (origin === undefined) {
    return { kind: "error", message: "--api must be an absolute http or https URL" }
  }
  return { kind: "run", repo, bot, api: origin }
}

const parseOrigin = (raw: string): string | undefined => {
  try {
    const url = new URL(raw)
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined
  } catch {
    return undefined
  }
}

// Removes the token value and any bearer header from a message before it reaches stderr.
export const redact = (text: string, secret: string | undefined): string => {
  const scrubbed = text.replace(/Bearer\s+\S+/g, "Bearer [redacted]")
  return secret === undefined || secret === "" ? scrubbed : scrubbed.split(secret).join("[redacted]")
}

const fail = (message: string): void => {
  process.stderr.write(`app-reef-mcp: ${message}\n`)
  process.exitCode = 2
}

const main = (): void => {
  const parsed = parseMcpArgs(process.argv.slice(2))
  if (parsed.kind === "help") {
    process.stdout.write(USAGE)
    return
  }
  if (parsed.kind === "error") {
    fail(`${parsed.message}\n${USAGE}`)
    return
  }
  const token = process.env[MCP_TOKEN_ENV]
  if (token === undefined || token === "") {
    fail(`${MCP_TOKEN_ENV} is not set`)
    return
  }
  const deps = makeReefApi({
    baseUrl: parsed.api,
    token: Redacted.make(token),
    repo: parsed.repo,
    bot: parsed.bot,
  })
  serveStdio(() => makeReefMcpServer(deps), {
    onerror: (error) => {
      process.stderr.write(`app-reef-mcp: ${redact(error.message, token)}\n`)
    },
  })
}

const isEntrypoint = (): boolean => {
  const invoked = process.argv[1]
  if (invoked === undefined) return false
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntrypoint()) {
  main()
}
