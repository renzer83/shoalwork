import { MD3DarkTheme, type MD3Theme } from "react-native-paper"

// Design v2 tokens (09-design/README.md §Tokens). Dark only. The screens of the new design read these directly;
// Paper is kept only for the older screens that are no longer in the navigation.
export const tokens = {
  color: {
    background: "#0A0F1C",
    surface: "#121A2B",
    elevated: "#18213A",
    border: "#1C2538",
    text: "#E8EEF8",
    textSecondary: "#8A97B0",
    accent: "#2F7BFF",
    link: "#5AA2FF",
    purple: "#7C5CFF",
    amber: "#F5A524",
    green: "#22C55E",
    red: "#EF4444",
    orange: "#F97316",
    // Translucent accent of the active row in the sidebar.
    accentSoft: "rgba(47, 123, 255, 0.18)",
    amberSoft: "rgba(245, 165, 36, 0.08)",
    greenSoft: "rgba(34, 197, 94, 0.16)",
    accentGlow: "rgba(47, 123, 255, 0.35)",
    scrim: "rgba(0, 0, 0, 0.6)",
    white: "#FFFFFF",
  },
  // Flat avatar colours of the Bots.
  avatarPalette: ["#2F7BFF", "#7C5CFF", "#F59E0B", "#EC4899", "#22D3EE", "#22C55E", "#EF4444", "#F4F6FA"],
  radius: { card: 14, button: 12, chip: 10, avatar: 12 },
  font: {
    size: 15,
    small: 13,
    mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
  },
  // Widths at the 1585 px wide reference; the shell scales them down on smaller windows (see shell-metrics).
  layout: { sidebarWidth: 430, panelWidth: 340 },
} as const

export type Tokens = typeof tokens

export const darkTheme: MD3Theme = {
  ...MD3DarkTheme,
  colors: {
    ...MD3DarkTheme.colors,
    primary: tokens.color.accent,
    secondary: tokens.color.textSecondary,
    error: tokens.color.red,
    background: tokens.color.background,
    surface: tokens.color.surface,
    onSurface: tokens.color.text,
    outlineVariant: tokens.color.border,
  },
}

// Only the dark theme exists; the argument stays so callers keep their shape.
export const lightTheme: MD3Theme = darkTheme

export const themeFor = (_scheme?: "light" | "dark" | null): MD3Theme => darkTheme

export const useAppTheme = (): MD3Theme => darkTheme
