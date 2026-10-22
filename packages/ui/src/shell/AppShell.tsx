import { type ReactNode, useMemo, useState } from "react"
import { useWindowDimensions, View } from "react-native"
import { tokens } from "../theme.js"
import { Sidebar } from "./Sidebar.js"
import { ShellContext, type ShellState } from "./shell-context.js"
import { shellMetrics } from "./shell-metrics.js"

export interface AppShellProps {
  readonly pathname: string
  readonly onNavigate: (href: string) => void
  readonly children: ReactNode
}

// Routes that are about reaching the core at all: no Bot list to show next to them.
const BARE_ROUTES: ReadonlyArray<string> = ["/", "/setup", "/health"]
export const CHAT_LIST_HREF = "/chat"

// The three-column shell: sidebar on the left, the routed screen in the middle (which owns its right panel, so
// the Configuração screen can fill it with the executor detail). On a phone it shows one column at a time:
// the list at /chat, the routed screen elsewhere.
export function AppShell({ pathname, onNavigate, children }: AppShellProps) {
  const { width } = useWindowDimensions()
  const metrics = shellMetrics(width)
  const [searchOpen, setSearchOpen] = useState(false)
  const bare = BARE_ROUTES.includes(pathname)
  const showList = metrics.narrow && pathname === CHAT_LIST_HREF
  const showSidebar = !bare && (!metrics.narrow || showList)
  const showCenter = !showList

  const state = useMemo<ShellState>(
    () => ({
      narrow: metrics.narrow,
      openList: () => onNavigate(CHAT_LIST_HREF),
      openSearch: () => setSearchOpen(true),
    }),
    [metrics.narrow, onNavigate],
  )

  return (
    <ShellContext.Provider value={state}>
      <View style={{ flex: 1, flexDirection: "row", backgroundColor: tokens.color.background }}>
        {showSidebar ? (
          <Sidebar
            width={metrics.sidebarWidth}
            pathname={pathname}
            onNavigate={onNavigate}
            searchOpen={searchOpen}
            onSearchOpenChange={setSearchOpen}
          />
        ) : null}
        {showCenter ? <View style={{ flex: 1, minWidth: 0 }}>{children}</View> : null}
      </View>
    </ShellContext.Provider>
  )
}
