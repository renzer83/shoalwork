import type * as acp from "@agentclientprotocol/sdk"
import { describe, expect, it } from "vitest"
import { planOf } from "../../src/acp/permissions.js"

const OPTIONS: Array<acp.PermissionOption> = [{ optionId: "yes", name: "Allow", kind: "allow_once" }]

describe("planOf", () => {
  const request = (toolCall: acp.ToolCallUpdate): acp.RequestPermissionRequest => ({
    sessionId: "s",
    toolCall,
    options: OPTIONS,
  })

  it("names the tools like the policy does", () => {
    expect(planOf(request({ toolCallId: "1", kind: "execute", rawInput: { command: "ls" } }))).toEqual({
      _tag: "Evaluate",
      calls: [{ tool: "Bash", input: { command: "ls" } }],
    })
    expect(planOf(request({ toolCallId: "1", kind: "read", locations: [{ path: "/w/a" }] }))).toEqual({
      _tag: "Evaluate",
      calls: [{ tool: "Read", input: { file_path: "/w/a" }, resource: "/w/a" }],
    })
    expect(planOf(request({ toolCallId: "1", kind: "delete", locations: [{ path: "/w/a" }] }))).toMatchObject(
      {
        calls: [{ tool: "delete" }],
      },
    )
    expect(planOf(request({ toolCallId: "1" }))).toEqual({
      _tag: "Evaluate",
      calls: [{ tool: "other", input: {} }],
    })
  })

  it("leaves out a command that is not a string, so the policy asks", () => {
    expect(
      planOf(request({ toolCallId: "1", kind: "execute", rawInput: { command: ["rm", "-rf", "/"] } })),
    ).toEqual({ _tag: "Evaluate", calls: [{ tool: "Bash", input: {} }] })
  })
})
