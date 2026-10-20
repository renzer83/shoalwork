import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { afterEach, describe, expect, vi } from "vitest"
import { UsageError } from "../src/args.js"
import { tideAdd, tideSetEnabled } from "../src/commands/tide.js"

const SETTINGS = { url: "http://localhost:28900", token: "dev-token" }
const TIDE_ID = "tide_0c0c0c0c-0000-4000-8000-000000000003"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("tide commands", () => {
  it.effect("add refuses a file that is not a JSON object before any request is sent", () => {
    const mock = vi.fn(async () => new Response("{}", { status: 201 }))
    vi.stubGlobal("fetch", mock)
    const dir = mkdtempSync(join(tmpdir(), "tide-cli-"))
    const file = join(dir, "tide.json")
    writeFileSync(file, "[1, 2]")
    return Effect.gen(function* () {
      const error = yield* Effect.flip(tideAdd(SETTINGS, { bot: "scout", file }))
      expect(error).toBeInstanceOf(UsageError)
      expect(mock).not.toHaveBeenCalled()
    }).pipe(Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))))
  })

  it.effect("add needs --bot and --file", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(tideAdd(SETTINGS, { bot: "scout" }))
      expect(error).toBeInstanceOf(UsageError)
    }),
  )

  it.effect("enable posts the switch to /tides/:id/enable", () => {
    const mock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    )
    vi.stubGlobal("fetch", mock)
    return Effect.gen(function* () {
      const result = yield* tideSetEnabled(SETTINGS, TIDE_ID, false)
      expect(result).toEqual({ ok: true })
      const [url, init] = mock.mock.calls[0] ?? []
      expect(String(url)).toBe(`${SETTINGS.url}/tides/${TIDE_ID}/enable`)
      expect(init?.body).toBe(JSON.stringify({ enabled: false }))
    })
  })

  it.effect("a malformed tide id is a usage error, not a request", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(tideSetEnabled(SETTINGS, "not-a-tide", true))
      expect(error).toBeInstanceOf(UsageError)
    }),
  )
})
