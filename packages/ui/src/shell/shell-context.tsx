import { createContext, useContext } from "react"

export interface ShellState {
  // One column at a time (phones).
  readonly narrow: boolean
  // Back to the Bot list: only meaningful when narrow.
  readonly openList: () => void
  // Opens the sidebar filter: the way to switch Bot from the chat header.
  readonly openSearch: () => void
}

const NOOP = (): void => undefined

export const ShellContext = createContext<ShellState>({ narrow: false, openList: NOOP, openSearch: NOOP })

export const useShell = (): ShellState => useContext(ShellContext)
