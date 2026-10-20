import { Event, streamIds, Tide } from "@shoalwork/contracts"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { renderTemplate, tideMatches } from "../src/index.js"
import { TEMPLATE } from "./support.js"

const BOT = "bot_3f2a9c1e-7b4d-4e8a-9f10-2c6d5e8b7a41"

const inbound = (channel: string, text: string): Event =>
  Schema.decodeUnknownSync(Event)({
    id: "evt_3f2a9c1e-7b4d-4e8a-9f10-2c6d5e8b7a41",
    streamId: streamIds.system,
    version: 1,
    position: 1,
    type: "message.inbound",
    payload: { channel, userId: "renan", text },
    actor: "user:renan",
    correlationId: "corr_render",
    occurredAt: "2026-10-20T10:00:00.000Z",
  })

const eventTide = (filter: Record<string, string | number | boolean | null> | undefined) =>
  Schema.decodeUnknownSync(Tide)({
    id: "tide_3f2a9c1e-7b4d-4e8a-9f10-2c6d5e8b7a41",
    botId: BOT,
    name: "on-message",
    kind: "event",
    eventType: "message.inbound",
    ...(filter === undefined ? {} : { eventFilter: filter }),
    timezone: "UTC",
    taskTemplate: TEMPLATE,
    enabled: true,
  })

describe("event filters", () => {
  it("match when every filter path holds its value, and not otherwise", () => {
    const tide = eventTide({ "payload.channel": "api" })
    expect(tideMatches(tide, inbound("api", "hi"))).toBe(true)
    expect(tideMatches(tide, inbound("telegram", "hi"))).toBe(false)
  })

  it("never match an event of another type, and match everything of the type without a filter", () => {
    const tide = eventTide(undefined)
    expect(tideMatches(tide, inbound("api", "hi"))).toBe(true)
    expect(tideMatches(tide, { ...inbound("api", "hi"), type: "error.raised" })).toBe(false)
  })
})

describe("renderTemplate", () => {
  it("interpolates payload paths as JSON data, so a value cannot close the template's own text", () => {
    const rendered = renderTemplate(
      "Answer {{payload.text}} from {{ payload.userId }}",
      inbound("api", 'a "b"\nc'),
    )
    expect(rendered).toBe('Answer "a \\"b\\"\\nc" from "renan"')
  })

  it("renders a missing path as null and leaves the rest of the text alone", () => {
    expect(renderTemplate("x={{payload.missing}} {literal} }}", inbound("api", "hi"))).toBe(
      "x=null {literal} }}",
    )
  })

  it("does not render a placeholder that came from a value", () => {
    expect(renderTemplate("{{payload.text}}", inbound("api", "{{payload.userId}}"))).toBe(
      '"{{payload.userId}}"',
    )
  })
})

describe("rendered size", () => {
  it("caps the whole rendered text, whatever the placeholders bring", () => {
    const rendered = renderTemplate("{{payload.text}}".repeat(6), inbound("api", "x".repeat(3000)))
    expect(rendered.length).toBe(8000)
  })
})
