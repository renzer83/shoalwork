#!/usr/bin/env node
// stdio entrypoint of the permission bridge (bin app-permission-bridge). stdout is the MCP protocol: nothing else is
// written there while serving. Diagnostics go to stderr, redacted.
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { serveStdio } from "@modelcontextprotocol/server/stdio"
import { Redacted } from "effect"
import { MCP_TOKEN_ENV } from "../mcp-config.js"
import { makeBridgeApi } from "./api.js"
import type { BridgeMode } from "./decide.js"
import { makePermissionBridgeServer } from "./server.js"

export const USAGE = [
  "usage: app-permission-bridge --api <url> [--mode inline|resume]",
  "",
  "  --api <url>   origin of the core API (http or https)",
  "  --mode <m>    inline (default): hold the tool until the approval is decided;",
  "                resume: deny an ask at once, the Lead resumes the session later",
  "",
  `The run's execution token is read from the ${MCP_TOKEN_ENV} environment variable (never from argv).`,
  "",
].join("\n")

export type BridgeArgs =
  | { readonly kind: "help" }
  | { readonly kind: "run"; readonly api: string; readonly mode: BridgeMode }
  | { readonly kind: "error"; readonly message: string }

const parseOrigin = (raw: string): string | undefined => {
  try {
    const url = new URL(raw)
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined
  } catch {
    return undefined
  }
}

// Pure: argv in, decision out. Tokens in argv would be visible to other users of the host, so --token is refused.
export const parseBridgeArgs = (argv: ReadonlyArray<string>): BridgeArgs => {
  const values: Record<string, string> = {}
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? ""
    if (flag === "--help" || flag === "-h") return { kind: "help" }
    if (flag === "--token" || flag.startsWith("--token=")) {
      return { kind: "error", message: `--token is not accepted; set ${MCP_TOKEN_ENV} instead` }
    }
    if (flag !== "--api" && flag !== "--mode") {
      return { kind: "error", message: `unknown argument: ${flag.slice(0, 64)}` }
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith("--")) {
      return { kind: "error", message: `${flag} needs a value` }
    }
    values[flag] = value
    index += 1
  }
  const api = values["--api"]
  if (api === undefined) return { kind: "error", message: "--api is required" }
  const origin = parseOrigin(api)
  if (origin === undefined) {
    return { kind: "error", message: "--api must be an absolute http or https URL" }
  }
  const mode = values["--mode"] ?? "inline"
  if (mode !== "inline" && mode !== "resume") {
    return { kind: "error", message: "--mode must be inline or resume" }
  }
  return { kind: "run", api: origin, mode }
}

// Removes the token value and any bearer header from a message before it reaches stderr.
export const redact = (text: string, secret: string | undefined): string => {
  const scrubbed = text.replace(/Bearer\s+\S+/g, "Bearer [redacted]")
  return secret === undefined || secret === "" ? scrubbed : scrubbed.split(secret).join("[redacted]")
}

const fail = (message: string): void => {
  process.stderr.write(`app-permission-bridge: ${message}\n`)
  process.exitCode = 2
}

const main = (): void => {
  const parsed = parseBridgeArgs(process.argv.slice(2))
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
  const api = makeBridgeApi({ baseUrl: parsed.api, token: Redacted.make(token) })
  serveStdio(() => makePermissionBridgeServer(api, { mode: parsed.mode }), {
    onerror: (error) => {
      process.stderr.write(`app-permission-bridge: ${redact(error.message, token)}\n`)
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
