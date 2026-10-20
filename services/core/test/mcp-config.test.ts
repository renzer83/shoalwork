import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { coreApiOrigin, REPO_ROOT, reefMcpEntryFrom } from "../src/config.js"

describe("coreApiOrigin", () => {
  it("uses the loopback address of the core when APP_URL is blank", () => {
    expect(coreApiOrigin("", 28900)).toBe("http://127.0.0.1:28900")
    expect(coreApiOrigin("   ", 3000)).toBe("http://127.0.0.1:3000")
  })

  it("uses APP_URL when it is set", () => {
    expect(coreApiOrigin("https://core.example.test", 28900)).toBe("https://core.example.test")
  })
})

describe("reefMcpEntryFrom", () => {
  it("defaults to the built reef server under the repo root when REEF_MCP_ENTRY is blank", () => {
    expect(reefMcpEntryFrom("")).toBe(resolve(REPO_ROOT, "packages/reef/dist/mcp.js"))
  })

  it("keeps an absolute REEF_MCP_ENTRY as it is", () => {
    expect(reefMcpEntryFrom("/opt/reef/mcp.js")).toBe("/opt/reef/mcp.js")
  })
})
