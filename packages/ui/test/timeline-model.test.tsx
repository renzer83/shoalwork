import { type Event, Event as EventSchema, TimelineItem } from "@shoalwork/contracts"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { chipLabel, mergeItems, reactTo, toRows, withApprovalStatus } from "../src/hooks/timeline-model.js"
import { translate } from "../src/i18n/index.js"
import {
  APPROVAL,
  approvalItem,
  BOT,
  commandEvent,
  eventId,
  fileEvent,
  message,
  TASK,
} from "./chat-support.js"

const items = (raw: ReadonlyArray<unknown>) =>
  raw.map((entry) => Schema.decodeUnknownSync(TimelineItem)(entry))

const liveEvent = (type: string, payload: unknown): Event =>
  Schema.decodeUnknownSync(EventSchema)({
    id: eventId(1),
    streamId: `bot:${BOT}`,
    version: 1,
    position: 1,
    type,
    payload,
    actor: "t",
    correlationId: "c",
    occurredAt: "2026-10-21T10:00:00.000Z",
  })

describe("toRows", () => {
  it("folds work of one task within 20 s and starts a new chip after the window", () => {
    const rows = toRows(
      items([
        commandEvent(1, 0, "a"),
        fileEvent(2, 10, "f.ts"),
        commandEvent(3, 20, "b"),
        commandEvent(4, 21, "c"),
      ]),
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ kind: "chip", commands: 2, files: 1, last: "b" })
    expect(rows[1]).toMatchObject({ kind: "chip", commands: 1, last: "c" })
  })

  it("lets a message close the chip so the order of the conversation is kept", () => {
    const rows = toRows(items([commandEvent(1, 0, "a"), message(2, "out", "hi", 1), commandEvent(3, 2, "b")]))
    expect(rows.map((row) => row.kind)).toEqual(["chip", "item", "chip"])
  })

  it("labels counts, with failures", () => {
    const [row] = toRows(items([commandEvent(1, 0, "a", 2), fileEvent(2, 1, "f.ts")]))
    expect(row?.kind === "chip" ? chipLabel(row, (key, params) => translate("en", key, params)) : "").toBe(
      "1 command (1 failed), 1 file edited",
    )
  })
})

describe("mergeItems", () => {
  it("replaces an item by key and keeps position order", () => {
    const current = items([message(2, "out", "two"), approvalItem(5, "pending")])
    const merged = mergeItems(current, items([message(1, "in", "one"), approvalItem(5, "approved")]))
    expect(merged.map((item) => item.position)).toEqual([1, 2, 5])
    expect(merged[2]).toMatchObject({ kind: "approval", status: "approved" })
  })

  it("patches the status of one approval", () => {
    const patched = withApprovalStatus(items([approvalItem(5, "pending")]), APPROVAL, "denied", "user:cli")
    expect(patched[0]).toMatchObject({ status: "denied", resolvedBy: "user:cli" })
  })
})

describe("reactTo", () => {
  it("applies a decided approval and ignores streaming text of a run", () => {
    expect(
      reactTo(liveEvent("approval.resolved", { approvalId: APPROVAL, decision: "approved", by: "user:web" })),
    ).toEqual({
      kind: "resolved",
      approvalId: APPROVAL,
      status: "approved",
      by: "user:web",
    })
    expect(
      reactTo(
        liveEvent("executor.event", { taskId: TASK, botId: BOT, event: { kind: "text", text: "..." } }),
      ),
    ).toEqual({ kind: "ignore" })
    expect(
      reactTo(
        liveEvent("executor.event", { taskId: TASK, botId: BOT, event: { kind: "command", cmd: "ls" } }),
      ),
    ).toEqual({ kind: "refresh" })
    expect(reactTo(liveEvent("message.outbound", { channel: "telegram", botId: BOT, text: "x" }))).toEqual({
      kind: "refresh",
    })
    expect(reactTo(liveEvent("approval.resolved", { nope: true }))).toEqual({ kind: "ignore" })
  })
})
