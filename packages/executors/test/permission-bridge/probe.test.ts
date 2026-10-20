import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport } from "@modelcontextprotocol/server"
import { describe, expect, it } from "vitest"
import {
  isProbeVariant,
  makeProbeServer,
  PROBE_VARIANTS,
  probeAnswer,
} from "../../src/permission-bridge/probe.js"

describe("permission probe (offline parts)", () => {
  it("builds each response variant the live test tries", () => {
    const input = { command: "ls" }
    expect(JSON.parse(probeAnswer("allow", input))).toEqual({ behavior: "allow", updatedInput: input })
    expect(JSON.parse(probeAnswer("allow-no-input", input))).toEqual({ behavior: "allow" })
    expect(JSON.parse(probeAnswer("deny", input))).toMatchObject({ behavior: "deny" })
    expect(probeAnswer("plain-allow", input)).toBe("allow")
    expect(PROBE_VARIANTS.every((variant) => isProbeVariant(variant))).toBe(true)
    expect(isProbeVariant("nope")).toBe(false)
  })

  it("records whatever arguments the CLI sends, extra fields included, and answers with the variant", async () => {
    const lines: Array<string> = []
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await makeProbeServer((line) => lines.push(line), "allow").connect(serverSide)
    const client = new Client({ name: "test", version: "1.0.0" })
    await client.connect(clientSide)
    const result = await client.callTool({
      name: "approve",
      arguments: { tool_name: "Write", input: { file_path: "probe.txt" }, tool_use_id: "t1", extra: true },
    })
    const recorded = JSON.parse(lines[0] ?? "null") as { variant: string; args: Record<string, unknown> }
    expect(recorded.variant).toBe("allow")
    expect(recorded.args).toEqual({
      tool_name: "Write",
      input: { file_path: "probe.txt" },
      tool_use_id: "t1",
      extra: true,
    })
    const first = result.content[0]
    expect(first !== undefined && first.type === "text" && JSON.parse(first.text)).toEqual({
      behavior: "allow",
      updatedInput: { file_path: "probe.txt" },
    })
    await client.close()
  })
})
