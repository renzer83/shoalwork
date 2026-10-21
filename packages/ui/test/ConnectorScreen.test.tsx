import { ApiClient } from "@shoalwork/api-client"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { PaperProvider } from "react-native-paper"
import { afterEach, describe, expect, it } from "vitest"
import { ConnectorScreen, StaticApiProvider, themeFor } from "../src/index.js"

const DEV_ID = "bot_00000000-0000-4000-8000-0000000000aa"
const OPS_ID = "bot_00000000-0000-4000-8000-0000000000bb"

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })

type Call = { readonly method: string; readonly path: string; readonly body: string | undefined }

// A fake core that records every call, so the test can see the PATCH and its body.
const recordingCore = (calls: Array<Call>): typeof fetch =>
  (async (input, init) => {
    const path = new URL(String(input)).pathname
    const method = init?.method ?? "GET"
    calls.push({ method, path, body: typeof init?.body === "string" ? init.body : undefined })
    const github = {
      id: "github",
      name: "GitHub",
      kind: "native",
      status: "enabled",
      permissions: [{ tool: "github.issues.list", risk: "read" }],
      bots: [],
      lastUsedAt: null,
    }
    if (path === "/connectors" && method === "GET") return json({ connectors: [github] })
    if (path === "/connectors/github/bots" && method === "PATCH") {
      return json({ connector: { ...github, bots: [{ id: OPS_ID, name: "ops", tools: "*" }] } })
    }
    if (path === "/connectors/github/usage") return json({ usage: [] })
    if (path === "/bots") {
      return json({
        bots: [
          { id: DEV_ID, name: "dev", role: "developer", state: "idle" },
          { id: OPS_ID, name: "ops", role: "operator", state: "idle" },
        ],
      })
    }
    return new Response("not found", { status: 404 })
  }) as typeof fetch

afterEach(cleanup)

describe("ConnectorScreen", () => {
  it("assigns the connector to the Bots picked, through one PATCH", async () => {
    const calls: Array<Call> = []
    render(
      <PaperProvider theme={themeFor("light")}>
        <StaticApiProvider client={new ApiClient("http://core.test", async () => null, recordingCore(calls))}>
          <ConnectorScreen id="github" />
        </StaticApiProvider>
      </PaperProvider>,
    )
    expect(await screen.findByText("Bots that use it")).toBeTruthy()
    fireEvent.click(screen.getByText("ops"))
    fireEvent.click(screen.getByText("Save bots"))
    await waitFor(() => expect(calls.some((call) => call.method === "PATCH")).toBe(true))
    const patch = calls.find((call) => call.method === "PATCH")
    expect(patch?.path).toBe("/connectors/github/bots")
    expect(JSON.parse(patch?.body ?? "null")).toEqual({ bots: ["ops"] })
  })
})
