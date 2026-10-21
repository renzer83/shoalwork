import type { MessageKey } from "../i18n/index.js"

// Central list of the app's main sections. An entry becomes visible only when its screen exists: the task that
// creates the route sets `ready: true` here, so the menu never links to a missing page.
export interface NavEntry {
  readonly key: string
  readonly href: string
  // The text of the entry comes from the message table, in the reader's language.
  readonly labelKey: MessageKey
  readonly ready: boolean
}

export const NAV_ENTRIES: ReadonlyArray<NavEntry> = [
  { key: "chat", href: "/chat", labelKey: "nav.chat", ready: true },
  { key: "bots", href: "/bots", labelKey: "nav.bots", ready: true },
  { key: "health", href: "/health", labelKey: "nav.health", ready: true },
  { key: "setup", href: "/setup", labelKey: "nav.setup", ready: true },
  { key: "projects", href: "/projects", labelKey: "nav.projects", ready: true },
  { key: "pods", href: "/pods", labelKey: "nav.pods", ready: true },
  { key: "beacon", href: "/beacon", labelKey: "nav.beacon", ready: true },
  { key: "currents", href: "/currents", labelKey: "nav.currents", ready: true },
  { key: "tides", href: "/tides", labelKey: "nav.tides", ready: true },
  { key: "executors", href: "/executors", labelKey: "nav.executors", ready: true },
]

export const visibleNavEntries = (entries: ReadonlyArray<NavEntry> = NAV_ENTRIES): ReadonlyArray<NavEntry> =>
  entries.filter((entry) => entry.ready)

// The entry owns its sub-pages too: /bots/<id> keeps "Bots" selected.
export const isActiveEntry = (entry: NavEntry, pathname: string): boolean =>
  pathname === entry.href || pathname.startsWith(`${entry.href}/`)
