import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport } from "@modelcontextprotocol/server"
import { Effect, Redacted } from "effect"
import { describe, expect, it } from "vitest"
import { MAX_BODY_BYTES, makeReefApi } from "../src/mcp/api.js"
import { makeReefMcpServer } from "../src/mcp/server.js"
import {
  type CodeHit,
  MAX_SNIPPET_CHARS,
  type MemoryHit,
  ReefApiError,
  type ReefMcpDeps,
} from "../src/mcp/tools.js"
import { parseMcpArgs, redact } from "../src/mcp.js"

const CHUNK_ID = "chk_0b9c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d"

const hit = (overrides: Partial<CodeHit> = {}): CodeHit => ({
  id: CHUNK_ID,
  path: "src/a.ts",
  startLine: 1,
  endLine: 10,
  lang: "ts",
  symbols: ["alpha"],
  content: "export const alpha = 1",
  score: 0.5,
  ...overrides,
})

const memory = (overrides: Partial<MemoryHit> = {}): MemoryHit => ({
  id: "mem_1",
  scope: "bot",
  kind: "semantic",
  content: "the deploy window is on Tuesday",
  score: 0.4,
  ...overrides,
})

const fakeDeps = (overrides: Partial<ReefMcpDeps> = {}): ReefMcpDeps => ({
  searchCode: () => Effect.succeed([hit()]),
  searchMemory: () => Effect.succeed([memory()]),
  readChunk: () => Effect.succeed(hit()),
  ...overrides,
})

const connect = async (deps: ReefMcpDeps): Promise<Client> => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const server = makeReefMcpServer(deps)
  await server.connect(serverSide)
  const client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(clientSide)
  return client
}

const textOf = (result: { readonly content: ReadonlyArray<{ readonly type: string }> }): string => {
  const first = result.content[0]
  return first !== undefined && first.type === "text" && "text" in first && typeof first.text === "string"
    ? first.text
    : ""
}

describe("reef MCP server", () => {
  it("lists the three tools", async () => {
    const client = await connect(fakeDeps())
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual(["read_chunk", "search_code", "search_memory"])
  })

  it("search_code returns the chunks as JSON without embeddings", async () => {
    const leaking = { ...hit(), embedding: [0.1, 0.2] }
    const client = await connect(fakeDeps({ searchCode: () => Effect.succeed([leaking]) }))
    const result = await client.callTool({ name: "search_code", arguments: { q: "alpha", k: 3 } })
    const parsed: unknown = JSON.parse(textOf(result))
    expect(parsed).toEqual([
      {
        id: CHUNK_ID,
        path: "src/a.ts",
        startLine: 1,
        endLine: 10,
        lang: "ts",
        symbols: ["alpha"],
        score: 0.5,
        snippet: "export const alpha = 1",
        truncated: false,
      },
    ])
    expect(textOf(result)).not.toContain("embedding")
  })

  it("caps results at six hits and snippets at 1200 characters", async () => {
    const many = Array.from({ length: 10 }, (_, index) => hit({ id: `c${index}`, content: "x".repeat(5000) }))
    const client = await connect(fakeDeps({ searchCode: () => Effect.succeed(many) }))
    const result = await client.callTool({ name: "search_code", arguments: { q: "alpha" } })
    const parsed: ReadonlyArray<{ snippet: string; truncated: boolean }> = JSON.parse(textOf(result))
    expect(parsed).toHaveLength(6)
    expect(parsed.every((item) => item.snippet.length === MAX_SNIPPET_CHARS && item.truncated)).toBe(true)
  })

  it("answers an empty query with a validation error and never calls the handler", async () => {
    let calls = 0
    const client = await connect(
      fakeDeps({
        searchCode: () => {
          calls += 1
          return Effect.succeed([])
        },
      }),
    )
    const result = await client.callTool({ name: "search_code", arguments: { q: "" } })
    expect(result.isError).toBe(true)
    expect(textOf(result).startsWith("Input validation error")).toBe(true)
    expect(calls).toBe(0)
  })

  it("rejects k above the six-result cap before the handler runs", async () => {
    let calls = 0
    const client = await connect(
      fakeDeps({
        searchCode: () => {
          calls += 1
          return Effect.succeed([])
        },
      }),
    )
    const result = await client.callTool({ name: "search_code", arguments: { q: "alpha", k: 7 } })
    expect(result.isError).toBe(true)
    expect(textOf(result).startsWith("Input validation error")).toBe(true)
    expect(calls).toBe(0)
  })

  it("rejects a read_chunk id that is not a chunk id", async () => {
    let calls = 0
    const client = await connect(
      fakeDeps({
        readChunk: () => {
          calls += 1
          return Effect.succeed(hit())
        },
      }),
    )
    for (const id of ["../x", ".", "..", "a/b"]) {
      const result = await client.callTool({ name: "read_chunk", arguments: { id } })
      expect(result.isError).toBe(true)
    }
    expect(calls).toBe(0)
  })

  it("truncates path, language and symbols to their limits", async () => {
    const long = hit({
      path: "p".repeat(900),
      lang: "l".repeat(90),
      symbols: Array.from({ length: 40 }, () => "s".repeat(300)),
    })
    const client = await connect(fakeDeps({ searchCode: () => Effect.succeed([long]) }))
    const result = await client.callTool({ name: "search_code", arguments: { q: "alpha" } })
    const parsed: ReadonlyArray<{ path: string; lang: string; symbols: ReadonlyArray<string> }> = JSON.parse(
      textOf(result),
    )
    const [item] = parsed
    expect(item?.path.length).toBe(512)
    expect(item?.lang.length).toBe(32)
    expect(item?.symbols).toHaveLength(32)
    expect(item?.symbols.every((symbol) => symbol.length === 128)).toBe(true)
  })

  it("search_memory returns memory items with snippets", async () => {
    const client = await connect(fakeDeps())
    const result = await client.callTool({ name: "search_memory", arguments: { q: "deploy" } })
    const parsed: unknown = JSON.parse(textOf(result))
    expect(parsed).toEqual([
      {
        id: "mem_1",
        scope: "bot",
        kind: "semantic",
        score: 0.4,
        snippet: "the deploy window is on Tuesday",
        truncated: false,
      },
    ])
  })

  it("read_chunk returns one chunk by id", async () => {
    const seen: Array<string> = []
    const client = await connect(
      fakeDeps({
        readChunk: (id) => {
          seen.push(id)
          return Effect.succeed(hit({ id }))
        },
      }),
    )
    const result = await client.callTool({ name: "read_chunk", arguments: { id: CHUNK_ID } })
    expect(seen).toEqual([CHUNK_ID])
    expect(JSON.parse(textOf(result))).toMatchObject({ id: CHUNK_ID, path: "src/a.ts" })
  })

  it("turns a backend failure into error text without a stack", async () => {
    const client = await connect(
      fakeDeps({
        searchCode: () => Effect.fail(new ReefApiError({ op: "search_code", reason: "HTTP 503" })),
      }),
    )
    const result = await client.callTool({ name: "search_code", arguments: { q: "alpha" } })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe("error: search_code failed (HTTP 503)")
    expect(textOf(result)).not.toContain("at ")
  })
})

type Captured = { url: string; authorization: string | null }

const fakeFetch =
  (respond: (captured: Captured) => Response, seen: Array<Captured>): typeof globalThis.fetch =>
  async (input, init) => {
    const headers = new Headers(init?.headers)
    const captured: Captured = { url: String(input), authorization: headers.get("authorization") }
    seen.push(captured)
    return respond(captured)
  }

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const apiOptions = (fetchImpl: typeof globalThis.fetch) => ({
  baseUrl: "http://core.test:3000/",
  token: Redacted.make("tok_secret_value"),
  repo: "shoalwork",
  bot: "bot_42",
  fetch: fetchImpl,
})

describe("reef HTTP client", () => {
  it("queries the core with the bearer token and drops embedding fields", async () => {
    const seen: Array<Captured> = []
    const deps = makeReefApi(apiOptions(fakeFetch(() => json([{ ...hit(), embedding: "AAAA" }]), seen)))
    const hits = await Effect.runPromise(deps.searchCode("alpha", 3))
    expect(hits).toHaveLength(1)
    expect(Object.keys(hits[0] ?? {})).not.toContain("embedding")
    expect(seen[0]?.url).toBe("http://core.test:3000/reef/search?repo=shoalwork&q=alpha&k=3")
    expect(seen[0]?.authorization).toBe("Bearer tok_secret_value")
  })

  it("maps a non 2xx answer to a reason without the body", async () => {
    const deps = makeReefApi(apiOptions(fakeFetch(() => json({ secret: "leak" }, 401), [])))
    const failure = await Effect.runPromise(Effect.flip(deps.readChunk(CHUNK_ID)))
    expect(failure).toBeInstanceOf(ReefApiError)
    expect(failure.reason).toBe("HTTP 401")
    expect(JSON.stringify(failure)).not.toContain("leak")
  })

  it("rejects an answer of the wrong shape", async () => {
    const deps = makeReefApi(apiOptions(fakeFetch(() => json({ not: "an array" }), [])))
    const failure = await Effect.runPromise(Effect.flip(deps.searchMemory("deploy", 2)))
    expect(failure.reason).toBe("unexpected response shape")
  })

  it("reads the chunk by id with no repo or bot parameter", async () => {
    const seen: Array<Captured> = []
    const deps = makeReefApi(apiOptions(fakeFetch(() => json(hit()), seen)))
    await Effect.runPromise(deps.readChunk(CHUNK_ID))
    expect(seen[0]?.url).toBe(`http://core.test:3000/reef/chunk/${CHUNK_ID}`)
  })

  it("refuses an invalid chunk id before any request", async () => {
    const seen: Array<Captured> = []
    const deps = makeReefApi(apiOptions(fakeFetch(() => json(hit()), seen)))
    const failure = await Effect.runPromise(Effect.flip(deps.readChunk("../admin")))
    expect(failure.reason).toBe("invalid chunk id")
    expect(seen).toEqual([])
  })

  it("refuses an answer above the body limit", async () => {
    const big = new Response("x".repeat(MAX_BODY_BYTES + 1), { status: 200 })
    const deps = makeReefApi(apiOptions(async () => big))
    const failure = await Effect.runPromise(Effect.flip(deps.searchMemory("deploy", 2)))
    expect(failure.reason).toBe("response too large")
  })

  it("reports a network failure without the token", async () => {
    const failing: typeof globalThis.fetch = async () => {
      throw new TypeError("fetch failed")
    }
    const deps = makeReefApi(apiOptions(failing))
    const failure = await Effect.runPromise(Effect.flip(deps.searchCode("alpha", 2)))
    expect(failure.reason).toBe("network error")
    expect(JSON.stringify(failure)).not.toContain("tok_secret_value")
  })
})

describe("reef MCP entrypoint arguments", () => {
  const base = ["--repo", "shoalwork", "--bot", "bot_42", "--api", "http://127.0.0.1:3000"]

  it("parses a complete command line", () => {
    expect(parseMcpArgs(base)).toEqual({
      kind: "run",
      repo: "shoalwork",
      bot: "bot_42",
      api: "http://127.0.0.1:3000/",
    })
  })

  it("answers --help", () => {
    expect(parseMcpArgs(["--help"])).toEqual({ kind: "help" })
  })

  it("refuses a token on argv", () => {
    const parsed = parseMcpArgs([...base, "--token", "abc"])
    expect(parsed.kind).toBe("error")
  })

  it("requires every flag and an absolute http(s) api url", () => {
    expect(parseMcpArgs(["--repo", "x"]).kind).toBe("error")
    expect(parseMcpArgs(["--repo", "x", "--bot", "y", "--api", "file:///etc/passwd"]).kind).toBe("error")
    expect(parseMcpArgs(["--repo", "x", "--bot", "y", "--api", "not a url"]).kind).toBe("error")
  })

  it("rejects unknown flags", () => {
    expect(parseMcpArgs([...base, "--verbose"]).kind).toBe("error")
  })

  it("redacts the token and bearer headers from stderr text", () => {
    expect(redact("failed with Bearer abc.def and tok_x", "tok_x")).toBe(
      "failed with Bearer [redacted] and [redacted]",
    )
  })
})
