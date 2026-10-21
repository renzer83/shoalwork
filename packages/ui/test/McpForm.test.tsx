import { ApiClient } from "@shoalwork/api-client"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { PaperProvider } from "react-native-paper"
import { afterEach, describe, expect, it } from "vitest"
import { McpForm, StaticApiProvider, themeFor } from "../src/index.js"

type Call = { readonly method: string; readonly path: string; readonly body: string | undefined }

const recordingCore = (calls: Array<Call>): typeof fetch =>
  (async (input, init) => {
    const path = new URL(String(input)).pathname
    const method = init?.method ?? "GET"
    calls.push({ method, path, body: typeof init?.body === "string" ? init.body : undefined })
    if (path === "/connectors/mcp" && method === "POST") {
      return new Response(JSON.stringify({ server: { name: "docs" } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      })
    }
    return new Response("not found", { status: 404 })
  }) as typeof fetch

const renderForm = (calls: Array<Call>) =>
  render(
    <PaperProvider theme={themeFor("light")}>
      <StaticApiProvider client={new ApiClient("http://core.test", async () => null, recordingCore(calls))}>
        <McpForm onSaved={() => undefined} />
      </StaticApiProvider>
    </PaperProvider>,
  )

const fillLocal = (envKeys: string) => {
  fireEvent.change(screen.getByTestId("mcp-name"), { target: { value: "docs" } })
  fireEvent.change(screen.getByTestId("mcp-command"), { target: { value: "node" } })
  fireEvent.change(screen.getByTestId("mcp-env-keys"), { target: { value: envKeys } })
}

afterEach(cleanup)

describe("McpForm", () => {
  it("refuses an env value written inline or as a reference, and sends nothing", async () => {
    const calls: Array<Call> = []
    renderForm(calls)
    fillLocal("op://vault/item/token")
    fireEvent.click(screen.getByText("Add server"))
    expect(await screen.findByText(/not a Vault key name/)).toBeTruthy()
    expect(calls.filter((call) => call.method === "POST")).toEqual([])
  })

  it("sends env entries as Vault key names only", async () => {
    const calls: Array<Call> = []
    renderForm(calls)
    fillLocal("GITHUB_TOKEN")
    fireEvent.click(screen.getByText("Add server"))
    await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true))
    const post = calls.find((call) => call.method === "POST")
    expect(post?.path).toBe("/connectors/mcp")
    expect(JSON.parse(post?.body ?? "null")).toMatchObject({
      name: "docs",
      transport: "stdio",
      envKeys: ["GITHUB_TOKEN"],
    })
  })
})
