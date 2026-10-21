// Central list of the app's main sections. An entry becomes visible only when its screen exists: the task that
// creates the route sets `ready: true` here, so the menu never links to a missing page.
export interface NavEntry {
  readonly key: string
  readonly href: string
  readonly label: string
  readonly ready: boolean
}

export const NAV_ENTRIES: ReadonlyArray<NavEntry> = [
  { key: "chat", href: "/chat", label: "Conversa", ready: true },
  { key: "bots", href: "/bots", label: "Bots", ready: true },
  { key: "health", href: "/health", label: "Saúde", ready: true },
  { key: "setup", href: "/setup", label: "Configurar", ready: true },
  { key: "projects", href: "/projects", label: "Projetos", ready: true },
  { key: "pods", href: "/pods", label: "Times", ready: true },
  { key: "beacon", href: "/beacon", label: "Farol", ready: true },
  { key: "currents", href: "/currents", label: "Correntes", ready: true },
  { key: "tides", href: "/tides", label: "Marés", ready: true },
]

export const visibleNavEntries = (entries: ReadonlyArray<NavEntry> = NAV_ENTRIES): ReadonlyArray<NavEntry> =>
  entries.filter((entry) => entry.ready)

// The entry owns its sub-pages too: /bots/<id> keeps "Bots" selected.
export const isActiveEntry = (entry: NavEntry, pathname: string): boolean =>
  pathname === entry.href || pathname.startsWith(`${entry.href}/`)
