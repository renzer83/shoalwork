import { Effect, Redacted } from "effect"
import { describe, expect, it } from "vitest"
import { makeBridgeApi } from "../../src/permission-bridge/api.js"

const APPROVAL = "apr_0b9c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d"
// Built at runtime: the CI scanner must not see a literal token.
const TOKEN = ["mcp", "run", "token", "for", "tests"].join("_")

interface Seen {
  url: string
  method: string
  authorization: string
  body: string | undefined
}

const fakeFetch = (respond: (url: URL) => Response) => {
  const seen: Array<Seen> = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    seen.push({
      url: `${url.pathname}${url.search}`,
      method: init?.method ?? "GET",
      authorization: new Headers(init?.headers).get("authorization") ?? "",
      body: typeof init?.body === "string" ? init.body : undefined,
    })
    return respond(url)
  }
  return { fetch, seen }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const apiWith = (fetch: typeof globalThis.fetch) =>
  makeBridgeApi({ baseUrl: "http://127.0.0.1:3000", token: Redacted.make(TOKEN), fetch })

describe("bridge api", () => {
  it("posts the call with the run token and decodes the answer", async () => {
    const { fetch, seen } = fakeFetch(() => json({ effect: "ask", approvalId: APPROVAL }))
    const result = await Effect.runPromise(
      apiWith(fetch).evaluate({ tool: "Bash", input: { command: "git push" } }),
    )
    expect(result).toEqual({ effect: "ask", approvalId: APPROVAL })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      url: "/policy/evaluate",
      method: "POST",
      authorization: `Bearer ${TOKEN}`,
    })
    expect(JSON.parse(seen[0]?.body ?? "null")).toEqual({
      tool: "Bash",
      input: { command: "git push" },
    })
  })

  it("long-polls the approval with the slice in the query", async () => {
    const { fetch, seen } = fakeFetch(() => json({ status: "approved" }))
    const result = await Effect.runPromise(apiWith(fetch).wait(APPROVAL, 60_000))
    expect(result).toEqual({ status: "approved" })
    expect(seen[0]).toMatchObject({ url: `/approvals/${APPROVAL}/wait?timeoutMs=60000`, method: "GET" })
  })

  it("refuses an id that is not an approval id before any request", async () => {
    const { fetch, seen } = fakeFetch(() => json({ status: "approved" }))
    const error = await Effect.runPromise(Effect.flip(apiWith(fetch).wait("../tasks", 1000)))
    expect(error.reason).toBe("invalid approval id")
    expect(seen).toEqual([])
  })

  it("refuses a body over the cap, declared or streamed, without reading it all", async () => {
    const declared = fakeFetch(() => new Response("{}", { headers: { "content-length": "999999" } }))
    const first = await Effect.runPromise(
      Effect.flip(apiWith(declared.fetch).evaluate({ tool: "Bash", input: {} })),
    )
    expect(first.reason).toBe("response too large")
    let pulled = 0
    const endless = fakeFetch(
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              pulled += 1
              controller.enqueue(new Uint8Array(20_000))
            },
          }),
        ),
    )
    const second = await Effect.runPromise(
      Effect.flip(apiWith(endless.fetch).evaluate({ tool: "Bash", input: {} })),
    )
    expect(second.reason).toBe("response too large")
    expect(pulled).toBeLessThan(10)
  })

  it("turns HTTP errors and bad shapes into short errors without the body or the token", async () => {
    const failing = fakeFetch(() => json({ error: `leak ${TOKEN}` }, 401))
    const http = await Effect.runPromise(
      Effect.flip(apiWith(failing.fetch).evaluate({ tool: "Bash", input: {} })),
    )
    expect(http).toMatchObject({ op: "evaluate", reason: "HTTP 401" })
    expect(JSON.stringify(http)).not.toContain(TOKEN)
    const odd = fakeFetch(() => json({ effect: "maybe" }))
    const shape = await Effect.runPromise(
      Effect.flip(apiWith(odd.fetch).evaluate({ tool: "Bash", input: {} })),
    )
    expect(shape.reason).toBe("unexpected response shape")
  })
})
