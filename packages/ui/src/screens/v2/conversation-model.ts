import type { BotDetail } from "@shoalwork/api-client"
import type { TimelineItem } from "@shoalwork/contracts"
import { isWebUrl } from "../../components/v2/chat/open-link.js"
import type { ChipRow, TimelineRow } from "../../hooks/timeline-model.js"

const DESCRIPTION_MAX = 180

// The first paragraph of the Bot's instructions, on one line and clipped: what the "Sobre este bot" card shows.
export const describeBot = (instructions: string): string => {
  const paragraph = instructions.trim().split(/\n\s*\n/)[0] ?? ""
  const line = paragraph.replace(/\s+/g, " ").trim()
  return line.length > DESCRIPTION_MAX ? `${line.slice(0, DESCRIPTION_MAX - 1)}…` : line
}

export const modelOf = (bot: BotDetail): string | undefined => {
  const tiers = bot.modelTiers
  return (tiers.chat ?? tiers.decision ?? tiers.heavy ?? tiers.light)?.model
}

export const fallbackOf = (bot: BotDetail): string | undefined =>
  bot.executors.allowed.find((executor) => executor !== bot.executors.preferred)

// Paths of the files the Bot edited most recently, newest first, without repeats.
export const recentFiles = (items: ReadonlyArray<TimelineItem>, limit = 5): ReadonlyArray<string> => {
  const seen = new Set<string>()
  for (let index = items.length - 1; index >= 0 && seen.size < limit; index -= 1) {
    const item = items[index]
    if (item?.kind === "event" && item.name === "file_edit" && item.text.trim() !== "") {
      seen.add(item.text.trim())
    }
  }
  return [...seen]
}

// Web links the Bot produced (pull requests and urls), newest first, without repeats.
export const usefulLinks = (items: ReadonlyArray<TimelineItem>, limit = 6): ReadonlyArray<string> => {
  const seen = new Set<string>()
  for (let index = items.length - 1; index >= 0 && seen.size < limit; index -= 1) {
    const item = items[index]
    if (
      item?.kind === "artifact" &&
      (item.artifactKind === "pr" || item.artifactKind === "url") &&
      isWebUrl(item.ref)
    ) {
      seen.add(item.ref)
    }
  }
  return [...seen]
}

type MessageItem = Extract<TimelineItem, { readonly kind: "message" }>
type ArtifactItem = Extract<TimelineItem, { readonly kind: "artifact" }>

// What the screen draws, in order: a Bot message with the artifacts it produced hanging in its bubble, one chip for a
// whole run of work, or any other item on its own.
export type Entry =
  | {
      readonly kind: "message"
      readonly key: string
      readonly item: MessageItem
      readonly cards: ReadonlyArray<ArtifactItem>
    }
  | { readonly kind: "chip"; readonly key: string; readonly chip: ChipRow }
  | { readonly kind: "item"; readonly key: string; readonly item: TimelineItem }

// Chip rows that touch each other (the 20 s fold of the timeline can split one burst of edits) become one chip.
export const mergeChips = (rows: ReadonlyArray<TimelineRow>): ReadonlyArray<TimelineRow> => {
  const merged: Array<TimelineRow> = []
  for (const row of rows) {
    const previous = merged.at(-1)
    if (row.kind === "chip" && previous?.kind === "chip") {
      merged[merged.length - 1] = {
        ...previous,
        commands: previous.commands + row.commands,
        failedCommands: previous.failedCommands + row.failedCommands,
        files: previous.files + row.files,
        last: row.last,
        endedAt: row.endedAt,
      }
    } else {
      merged.push(row)
    }
  }
  return merged
}

export const toEntries = (rows: ReadonlyArray<TimelineRow>): ReadonlyArray<Entry> => {
  const entries: Array<Entry> = []
  for (const row of mergeChips(rows)) {
    if (row.kind === "chip") {
      entries.push({ kind: "chip", key: row.key, chip: row })
      continue
    }
    const { item } = row
    const previous = entries.at(-1)
    if (item.kind === "artifact" && previous?.kind === "message" && previous.item.direction === "out") {
      entries[entries.length - 1] = { ...previous, cards: [...previous.cards, item] }
    } else if (item.kind === "message") {
      entries.push({ kind: "message", key: row.key, item, cards: [] })
    } else {
      entries.push({ kind: "item", key: row.key, item })
    }
  }
  return entries
}
