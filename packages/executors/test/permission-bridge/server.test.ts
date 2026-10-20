import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport } from "@modelcontextprotocol/server"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import type { BridgeApi, EvaluateResult } from "../../src/permission-bridge/api.js"
import { makePermissionBridgeServer, PERMISSION_TOOL_REF } from "../../src/permission-bridge/server.js"

const APPROVAL = "apr_0b9c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d"

const fakeApi = (
  answers: ReadonlyArray<EvaluateResult>,
  waits: ReadonlyArray<"approved" | "denied"> = [],
) => {
  const calls: Array<unknown> = []
  let index = 0
  let waitIndex = 0
  const api: BridgeApi = {
    evaluate: (call) => {
      calls.push(call)
      const answer = answers[Math.min(index, answers.length - 1)] ?? { effect: "deny" as const }
      index += 1
      return Effect.succeed(answer)
    },
    wait: () => {
      const status = waits[Math.min(waitIndex, waits.length - 1)] ?? "denied"
      waitIndex += 1
      return Effect.succeed({ status })
    },
  }
  return { api, calls }
}

const connect = async (api: BridgeApi): Promise<Client> => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await makePermissionBridgeServer(api).connect(serverSide)
  const client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(clientSide)
  return client
}

const verdictOf = (result: { readonly content: ReadonlyArray<{ readonly type: string }> }): unknown => {
  const first = result.content[0]
  return JSON.parse(
    first !== undefined && first.type === "text" && "text" in first ? String(first.text) : "null",
  )
}

describe("permission-bridge MCP server", () => {
  it("names the tool the CLI is pointed at", async () => {
    const client = await connect(fakeApi([{ effect: "allow" }]).api)
    const { tools } = await client.listTools()
    expect(tools.map((tool) => `mcp__permission-bridge__${tool.name}`)).toEqual([PERMISSION_TOOL_REF])
    await client.close()
  })

  it("answers an allow as JSON text with the original input", async () => {
    const { api, calls } = fakeApi([{ effect: "allow" }])
    const client = await connect(api)
    const result = await client.callTool({
      name: "approve",
      arguments: {
        tool_name: "Write",
        input: { file_path: "/work/tree/a.txt", content: "ok" },
        tool_use_id: "t1",
      },
    })
    expect(result.isError).not.toBe(true)
    expect(verdictOf(result)).toEqual({
      behavior: "allow",
      updatedInput: { file_path: "/work/tree/a.txt", content: "ok" },
    })
    expect(calls).toEqual([{ tool: "Write", input: { file_path: "/work/tree/a.txt", content: "ok" } }])
    await client.close()
  })

  it("answers a deny with the message", async () => {
    const client = await connect(fakeApi([{ effect: "deny", reason: "blocked by policy" }]).api)
    const result = await client.callTool({
      name: "approve",
      arguments: { tool_name: "Bash", input: { command: "rm -rf /" } },
    })
    expect(verdictOf(result)).toEqual({ behavior: "deny", message: "blocked by policy" })
    await client.close()
  })

  it("holds the call on an ask and allows once the approval is granted", async () => {
    const { api, calls } = fakeApi(
      [
        { effect: "ask", approvalId: APPROVAL },
        { effect: "allow", approvalId: APPROVAL },
      ],
      ["approved"],
    )
    const client = await connect(api)
    const result = await client.callTool({
      name: "approve",
      arguments: { tool_name: "Bash", input: { command: "git push" } },
    })
    expect(verdictOf(result)).toMatchObject({ behavior: "allow" })
    expect(calls).toHaveLength(2)
    await client.close()
  })

  it("keeps extra fields the CLI may add and rejects a call without tool_name", async () => {
    const client = await connect(fakeApi([{ effect: "allow" }]).api)
    const extra = await client.callTool({
      name: "approve",
      arguments: { tool_name: "Read", input: {}, future_field: 1 },
    })
    expect(verdictOf(extra)).toMatchObject({ behavior: "allow" })
    const invalid = await client.callTool({ name: "approve", arguments: { input: {} } })
    expect(invalid.isError).toBe(true)
    await client.close()
  })

  it("a cancelled call stops waiting, and an approval that arrives later is never spent", async () => {
    let evaluations = 0
    let approve: () => void = () => undefined
    const approved = new Promise<void>((resolve) => {
      approve = resolve
    })
    let interrupted: () => void = () => undefined
    const waitInterrupted = new Promise<void>((resolve) => {
      interrupted = resolve
    })
    let started: () => void = () => undefined
    const waiting = new Promise<void>((resolve) => {
      started = resolve
    })
    const api: BridgeApi = {
      evaluate: () => {
        evaluations += 1
        return Effect.succeed(
          evaluations === 1 ? { effect: "ask", approvalId: APPROVAL } : { effect: "allow" },
        )
      },
      wait: () =>
        Effect.promise(() => {
          started()
          return approved
        }).pipe(
          Effect.as({ status: "approved" as const }),
          Effect.onInterrupt(() => Effect.sync(interrupted)),
        ),
    }
    const client = await connect(api)
    const controller = new AbortController()
    const call = client
      .callTool(
        { name: "approve", arguments: { tool_name: "Bash", input: { command: "git push" } } },
        { signal: controller.signal },
      )
      .catch(() => "cancelled")
    await waiting
    controller.abort()
    await waitInterrupted
    approve()
    expect(await call).toBe("cancelled")
    // The ticket is spent only by a second evaluate; there was none.
    expect(evaluations).toBe(1)
    await client.close()
  })
})
