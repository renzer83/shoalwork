import { ApiClient } from "@shoalwork/api-client"
import { cleanup, render, screen } from "@testing-library/react"
import { PaperProvider } from "react-native-paper"
import { afterEach, describe, expect, it } from "vitest"
import { CurrentsScreen, StaticApiProvider, themeFor } from "../src/index.js"

const BOT_ID = "bot_00000000-0000-4000-8000-0000000000aa"

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })

const fakeCore: typeof fetch = async (input) => {
  const path = new URL(String(input)).pathname
  if (path === "/connectors") {
    return json({
      connectors: [
        {
          id: "github",
          name: "GitHub",
          kind: "native",
          status: "enabled",
          permissions: [{ tool: "github.issues.list", risk: "read" }],
          bots: [],
          lastUsedAt: null,
        },
        {
          id: "mcp_00000000-0000-4000-8000-0000000000bb",
          name: "docs",
          kind: "mcp",
          status: "enabled",
          permissions: [{ tool: "*", risk: "external" }],
          bots: [{ id: BOT_ID, name: "dev", tools: "*" }],
          lastUsedAt: null,
        },
      ],
    })
  }
  return new Response("not found", { status: 404 })
}

afterEach(cleanup)

describe("CurrentsScreen", () => {
  it("renders the catalog grouped by kind, with no group for a kind that has no connector", async () => {
    render(
      <PaperProvider theme={themeFor("light")}>
        <StaticApiProvider client={new ApiClient("http://core.test", async () => null, fakeCore)}>
          <CurrentsScreen />
        </StaticApiProvider>
      </PaperProvider>,
    )
    expect(await screen.findByText("Native connectors")).toBeTruthy()
    expect(screen.getByText("MCP servers")).toBeTruthy()
    expect(screen.getByText("GitHub")).toBeTruthy()
    expect(screen.getByText("docs")).toBeTruthy()
    expect(screen.queryByText("Browser")).toBeNull()
  })
})
