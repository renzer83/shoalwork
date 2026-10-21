import { decodeApprovalResolved, decodeExecutorEventPayload } from "@shoalwork/api-client"
import type { Event, TimelineItem } from "@shoalwork/contracts"
import { DateTime, Option } from "effect"
import type { Translate } from "../i18n/index.js"

// Pure parts of the conversation timeline (T-113): merging pages, the 20 s chip rule and the reaction to live events.

export const CHIP_WINDOW_MS = 20_000

export const itemKey = (item: TimelineItem): string => {
  switch (item.kind) {
    case "message":
      return `message:${item.eventId}`
    case "approval":
      return `approval:${item.approvalId}`
    case "artifact":
      return `artifact:${item.position}:${item.ref}`
    case "event":
      return `event:${item.position}:${item.name}:${item.text}`
  }
}

// Union by key (a newer copy replaces an older one), ordered by position. Stable for equal positions.
export const mergeItems = (
  current: ReadonlyArray<TimelineItem>,
  incoming: ReadonlyArray<TimelineItem>,
): ReadonlyArray<TimelineItem> => {
  const byKey = new Map<string, TimelineItem>()
  for (const item of current) byKey.set(itemKey(item), item)
  for (const item of incoming) byKey.set(itemKey(item), item)
  return [...byKey.values()]
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.position - b.item.position || a.index - b.index)
    .map((entry) => entry.item)
}

export const lastPosition = (items: ReadonlyArray<TimelineItem>): number =>
  items.reduce((max, item) => Math.max(max, item.position), 0)

type ApprovalItem = Extract<TimelineItem, { readonly kind: "approval" }>

export const withApprovalStatus = (
  items: ReadonlyArray<TimelineItem>,
  approvalId: string,
  status: ApprovalItem["status"],
  resolvedBy?: string,
): ReadonlyArray<TimelineItem> =>
  items.map((item) =>
    item.kind === "approval" && item.approvalId === approvalId
      ? { ...item, status, ...(resolvedBy === undefined ? {} : { resolvedBy }) }
      : item,
  )

export type ChipRow = {
  readonly kind: "chip"
  readonly key: string
  readonly taskId: string
  readonly commands: number
  readonly failedCommands: number
  readonly files: number
  readonly last: string
  readonly endedAt: number
}

export type TimelineRow =
  | { readonly kind: "item"; readonly key: string; readonly item: TimelineItem }
  | ChipRow

const millis = (item: TimelineItem): number => DateTime.toEpochMillis(item.occurredAt)

// Commands and file edits of one task that happen within 20 s of the first one fold into one chip; any other item
// (a message, an approval, a state change) closes the chip, so the order of the conversation is kept.
export const toRows = (items: ReadonlyArray<TimelineItem>): ReadonlyArray<TimelineRow> => {
  const rows: Array<TimelineRow> = []
  let open: { chip: ChipRow; startedAt: number } | undefined
  for (const item of items) {
    const work = item.kind === "event" && (item.name === "command" || item.name === "file_edit")
    if (!work) {
      open = undefined
      rows.push({ kind: "item", key: itemKey(item), item })
      continue
    }
    const at = millis(item)
    const isCommand = item.name === "command"
    const failed = isCommand && item.exitCode !== undefined && item.exitCode !== 0
    if (open !== undefined && open.chip.taskId === item.taskId && at - open.startedAt <= CHIP_WINDOW_MS) {
      const merged: ChipRow = {
        ...open.chip,
        commands: open.chip.commands + (isCommand ? 1 : 0),
        failedCommands: open.chip.failedCommands + (failed ? 1 : 0),
        files: open.chip.files + (isCommand ? 0 : 1),
        last: item.text,
        endedAt: at,
      }
      rows[rows.length - 1] = merged
      open = { chip: merged, startedAt: open.startedAt }
      continue
    }
    const chip: ChipRow = {
      kind: "chip",
      key: `chip:${item.position}`,
      taskId: item.taskId,
      commands: isCommand ? 1 : 0,
      failedCommands: failed ? 1 : 0,
      files: isCommand ? 0 : 1,
      last: item.text,
      endedAt: at,
    }
    rows.push(chip)
    open = { chip, startedAt: at }
  }
  return rows
}

export const chipLabel = (chip: ChipRow, t: Translate): string => {
  const parts: Array<string> = []
  if (chip.commands > 0) {
    const label = t(chip.commands === 1 ? "chat.commands.one" : "chat.commands.other", {
      count: chip.commands,
    })
    const failed =
      chip.failedCommands > 0 ? ` (${t("chat.commands.failed", { count: chip.failedCommands })})` : ""
    parts.push(`${label}${failed}`)
  }
  if (chip.files > 0) {
    parts.push(t(chip.files === 1 ? "chat.files.one" : "chat.files.other", { count: chip.files }))
  }
  return parts.join(", ")
}

export const LIVE_TYPES = [
  "message.inbound",
  "message.outbound",
  "task.state_changed",
  "executor.event",
  "executor.finished",
  "approval.requested",
  "approval.resolved",
] as const

export type LiveReaction =
  | { readonly kind: "ignore" }
  | { readonly kind: "refresh" }
  | {
      readonly kind: "resolved"
      readonly approvalId: string
      readonly status: ApprovalItem["status"]
      readonly by: string
    }

// What a live event means for an open conversation. Most events only say "ask the core for what is new"; a decided
// approval is applied at once, so the card closes without waiting for a round trip. Streaming text and thinking of a
// run are not part of the timeline.
// The Bot an event is about, when its payload says so (task and state events do not).
const payloadBotId = (payload: unknown): string | undefined => {
  if (typeof payload !== "object" || payload === null) return undefined
  const value: unknown = Reflect.get(payload, "botId")
  return typeof value === "string" ? value : undefined
}

const classify = (event: Event, botId: string | undefined): LiveReaction => {
  const about = payloadBotId(event.payload)
  if (botId !== undefined && about !== undefined && about !== botId) return { kind: "ignore" }
  if (event.type === "approval.resolved") {
    const payload = decodeApprovalResolved(event.payload)
    return Option.isSome(payload)
      ? {
          kind: "resolved",
          approvalId: payload.value.approvalId,
          status: payload.value.decision,
          by: payload.value.by,
        }
      : { kind: "ignore" }
  }
  if (event.type === "executor.event") {
    const payload = decodeExecutorEventPayload(event.payload)
    if (Option.isNone(payload)) return { kind: "ignore" }
    const kind = payload.value.event.kind
    return kind === "command" || kind === "file_edit" || kind === "done"
      ? { kind: "refresh" }
      : { kind: "ignore" }
  }
  return { kind: "refresh" }
}

// A payload the decoders cannot even run on must not end the feed: ask the core what is new instead.
export const reactTo = (event: Event, botId?: string): LiveReaction => {
  try {
    return classify(event, botId)
  } catch {
    return { kind: "refresh" }
  }
}
