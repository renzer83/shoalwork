import { tokens } from "../theme.js"

export interface ShellMetrics {
  readonly sidebarWidth: number
  // 0 when the right panel does not fit.
  readonly panelWidth: number
  // Below this the shell shows one column at a time.
  readonly narrow: boolean
}

export const NARROW_BELOW = 720
export const PANEL_MIN_WINDOW = 1000

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

// The reference is 1585 px wide: sidebar 430 and panel 340. Smaller windows scale both down so the chat keeps room.
export const shellMetrics = (windowWidth: number): ShellMetrics => {
  if (windowWidth < NARROW_BELOW) {
    return { sidebarWidth: windowWidth, panelWidth: 0, narrow: true }
  }
  const sidebarWidth = clamp(Math.round(windowWidth * 0.27), 280, tokens.layout.sidebarWidth)
  const panelWidth =
    windowWidth < PANEL_MIN_WINDOW ? 0 : clamp(Math.round(windowWidth * 0.215), 260, tokens.layout.panelWidth)
  return { sidebarWidth, panelWidth, narrow: false }
}
