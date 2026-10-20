#!/usr/bin/env node
// LIVE probe (T-055 step 1, run by T-166): a minimal MCP server that records what the CLI sends to its permission
// tool and answers with the variant chosen in PROBE_VARIANT. It never talks to the core.
import { appendFileSync, realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { McpServer } from "@modelcontextprotocol/server"
import { serveStdio } from "@modelcontextprotocol/server/stdio"
import * as z from "zod/v4"
import { SERVER_NAME, TOOL_NAME } from "./server.js"

export const PROBE_LOG_ENV = "PROBE_LOG"
export const PROBE_VARIANT_ENV = "PROBE_VARIANT"
// Response shapes the probe can return, in the order the live test tries them.
export const PROBE_VARIANTS = ["allow", "allow-no-input", "deny", "plain-allow"] as const
export type ProbeVariant = (typeof PROBE_VARIANTS)[number]

export const isProbeVariant = (value: string | undefined): value is ProbeVariant =>
  PROBE_VARIANTS.some((variant) => variant === value)

export const probeAnswer = (variant: ProbeVariant, input: unknown): string => {
  switch (variant) {
    case "allow":
      return JSON.stringify({ behavior: "allow", updatedInput: input })
    case "allow-no-input":
      return JSON.stringify({ behavior: "allow" })
    case "deny":
      return JSON.stringify({ behavior: "deny", message: "probe: denied on purpose" })
    case "plain-allow":
      return "allow"
  }
}

export const makeProbeServer = (record: (line: string) => void, variant: ProbeVariant): McpServer => {
  const server = new McpServer({ name: SERVER_NAME, version: "0.0.0" }, { capabilities: { tools: {} } })
  server.registerTool(
    TOOL_NAME,
    {
      description: "Records the permission request and answers with the probe variant.",
      // Loose on purpose: the probe exists to learn which fields the CLI really sends.
      inputSchema: z.looseObject({}),
    },
    (args) => {
      record(JSON.stringify({ receivedAt: new Date().toISOString(), variant, args }))
      return { content: [{ type: "text", text: probeAnswer(variant, args.input) }] }
    },
  )
  return server
}

const main = (): void => {
  const logPath = process.env[PROBE_LOG_ENV]
  const variant = process.env[PROBE_VARIANT_ENV]
  if (logPath === undefined || logPath === "" || !isProbeVariant(variant)) {
    process.stderr.write(
      `probe: set ${PROBE_LOG_ENV} and ${PROBE_VARIANT_ENV} (${PROBE_VARIANTS.join("|")})\n`,
    )
    process.exitCode = 2
    return
  }
  serveStdio(() => makeProbeServer((line) => appendFileSync(logPath, `${line}\n`), variant))
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
