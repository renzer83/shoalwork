import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { newBotId, newTideId } from "@shoalwork/contracts"
import { Effect } from "effect"
import { afterEach, describe, expect, vi } from "vitest"
import { takeSwitch, tideAdd, tideWebhook } from "../src/commands/tide.js"

const SETTINGS = { url: "http://localhost:28900", token: "dev-token" }
const TIDE_ID = newTideId()
const SECRET = "s3cr3t-shown-once"

const createdTide = {
  tide: {
    id: TIDE_ID,
    botId: newBotId(),
    name: "morning",
    kind: "cron",
    cronExpr: "0 9 * * *",
    timezone: "UTC",
    cooldownSeconds: 60,
    maxFiresPerHour: 30,
    taskTemplate: {
      title: "Check",
      prompt: "Look",
      kind: "research",
      tier: "light",
      budget: { tokens: 500, seconds: 300, usd: 0.5 },
    },
    enabled: true,
  },
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("takeSwitch", () => {
  it("takes the switch out and keeps the value flags as parseArgs reads them", () => {
    const result = takeSwitch(["--bot", "scout", "--webhook", "--file", "t.json"], "webhook")
    expect(result.on).toBe(true)
    expect(result.rest).toEqual(["--bot", "scout", "--file", "t.json"])
  })

  it("does not take the word as a value: a flag value that reads --webhook stays a value", () => {
    const result = takeSwitch(["--bot", "--webhook"], "webhook")
    expect(result.on).toBe(false)
    expect(result.rest).toEqual(["--bot", "--webhook"])
  })

  it("answers off when the switch is absent", () => {
    expect(takeSwitch(["--bot", "scout"], "webhook")).toEqual({ on: false, rest: ["--bot", "scout"] })
  })
})

describe("tide add --webhook", () => {
  it.effect("creates the tide, then asks for its secret and returns it in the answer", () => {
    const mock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      return url.endsWith("/webhook-secret")
        ? json({ tideId: TIDE_ID, path: `/webhooks/generic/${TIDE_ID}`, secret: SECRET }, 201)
        : json(createdTide, 201)
    })
    vi.stubGlobal("fetch", mock)
    const dir = mkdtempSync(join(tmpdir(), "tide-webhook-cli-"))
    const file = join(dir, "tide.json")
    writeFileSync(file, JSON.stringify({ name: "morning", kind: "cron", cronExpr: "0 9 * * *" }))
    return Effect.gen(function* () {
      const result = yield* tideAdd(SETTINGS, { bot: "scout", file }, true)
      expect(result).toMatchObject({ tide: { id: TIDE_ID }, webhook: { secret: SECRET } })
      const [first, second] = mock.mock.calls.map((call) => String(call[0]))
      expect(first).toBe(`${SETTINGS.url}/tides`)
      expect(second).toBe(`${SETTINGS.url}/tides/${TIDE_ID}/webhook-secret`)
    }).pipe(Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))))
  })

  it.effect("without the switch no secret is requested", () => {
    const mock = vi.fn(async () => json(createdTide, 201))
    vi.stubGlobal("fetch", mock)
    const dir = mkdtempSync(join(tmpdir(), "tide-webhook-cli-"))
    const file = join(dir, "tide.json")
    writeFileSync(file, JSON.stringify({ name: "morning", kind: "cron", cronExpr: "0 9 * * *" }))
    return Effect.gen(function* () {
      const result = yield* tideAdd(SETTINGS, { bot: "scout", file })
      expect(result).toEqual(createdTide)
      expect(mock).toHaveBeenCalledTimes(1)
    }).pipe(Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))))
  })
})

describe("tide webhook", () => {
  it.effect("posts a rotation to /tides/:id/webhook-secret and returns the new secret", () => {
    const mock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      json({ tideId: TIDE_ID, path: `/webhooks/generic/${TIDE_ID}`, secret: SECRET }, 201),
    )
    vi.stubGlobal("fetch", mock)
    return Effect.gen(function* () {
      const result = yield* tideWebhook(SETTINGS, TIDE_ID)
      expect(result).toMatchObject({ secret: SECRET })
      const [url, init] = mock.mock.calls[0] ?? []
      expect(String(url)).toBe(`${SETTINGS.url}/tides/${TIDE_ID}/webhook-secret`)
      expect(init?.method).toBe("POST")
    })
  })
})
