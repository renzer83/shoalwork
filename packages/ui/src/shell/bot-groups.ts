import type { BotSummary } from "@shoalwork/api-client"
import type { Translate } from "../i18n/index.js"

export const GUIDE_NAME = "lead"

export interface BotPreview {
  readonly text: string
  readonly at: number
}

export interface BotGroup {
  // Stable key: the project name, or "" for the Bots without one.
  readonly key: string
  readonly title: string
  readonly bots: ReadonlyArray<BotSummary>
}

// Bots grouped by project; the Guide has its own hero and is not listed. Groups with a project come first, in the
// order the projects appear; "Sem projeto" is always last. `filter` narrows by name or role (the 🔍 button).
export const groupBots = (
  bots: ReadonlyArray<BotSummary>,
  t: Translate,
  filter = "",
): ReadonlyArray<BotGroup> => {
  const needle = filter.trim().toLowerCase()
  const keep = (bot: BotSummary): boolean =>
    bot.name !== GUIDE_NAME &&
    (needle === "" || bot.name.toLowerCase().includes(needle) || bot.role.toLowerCase().includes(needle))
  const byProject = new Map<string, Array<BotSummary>>()
  for (const bot of bots.filter(keep)) {
    const key = bot.project?.trim() ?? ""
    byProject.set(key, [...(byProject.get(key) ?? []), bot])
  }
  const named = [...byProject.entries()].filter(([key]) => key !== "")
  const groups: Array<BotGroup> = named.map(([key, list]) => ({ key, title: key, bots: list }))
  const orphans = byProject.get("")
  if (orphans !== undefined) {
    groups.push({ key: "", title: t("shell.noProject"), bots: orphans })
  }
  return groups
}

const pad = (value: number): string => String(value).padStart(2, "0")

const startOfDay = (millis: number): number => {
  const date = new Date(millis)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

// "14:03" today, "Ontem" yesterday, "21/10" before that.
export const whenLabel = (millis: number, now: number, t: Translate): string => {
  const days = Math.round((startOfDay(now) - startOfDay(millis)) / 86_400_000)
  const date = new Date(millis)
  if (days <= 0) return `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (days === 1) return t("shell.yesterday")
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}`
}

// Which Bot a /chat/<x> path opens: by id or by name.
export const chatTarget = (pathname: string): string | undefined => {
  const match = /^\/chat\/([^/]+)/.exec(pathname)
  return match?.[1] === undefined ? undefined : decodeURIComponent(match[1])
}

export const isBotRef = (bot: BotSummary, ref: string | undefined): boolean =>
  ref !== undefined && (bot.id === ref || bot.name === ref)
