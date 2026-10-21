import type { ReactNode } from "react"
import { useWindowDimensions, View } from "react-native"
import { Text, useTheme } from "react-native-paper"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { NavItem } from "./NavItem.js"
import { isActiveEntry, NAV_ENTRIES, type NavEntry, visibleNavEntries } from "./nav-entries.js"

// From this width the menu is a persistent sidebar (desktop and wide web); below it, a bottom bar (phones).
export const SIDEBAR_MIN_WIDTH = 720
const SIDEBAR_WIDTH = 200

export interface AppNavigationProps {
  readonly pathname: string
  readonly onNavigate: (href: string) => void
  readonly entries?: ReadonlyArray<NavEntry>
  readonly children: ReactNode
}

export function AppNavigation({ pathname, onNavigate, entries = NAV_ENTRIES, children }: AppNavigationProps) {
  const theme = useTheme()
  const { width } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const items = visibleNavEntries(entries)
  const wide = width >= SIDEBAR_MIN_WIDTH

  const list = items.map((entry) => (
    <NavItem key={entry.key} entry={entry} active={isActiveEntry(entry, pathname)} onPress={onNavigate} />
  ))

  if (wide) {
    return (
      <View style={{ flex: 1, flexDirection: "row", backgroundColor: theme.colors.background }}>
        <View
          role="navigation"
          accessibilityLabel="Main menu"
          style={{
            width: SIDEBAR_WIDTH,
            padding: 8,
            gap: 4,
            borderRightWidth: 1,
            borderColor: theme.colors.outlineVariant,
            backgroundColor: theme.colors.surface,
          }}
        >
          <Text variant="titleMedium" style={{ paddingHorizontal: 12, paddingVertical: 8 }}>
            Shoalwork
          </Text>
          {list}
        </View>
        <View style={{ flex: 1 }}>{children}</View>
      </View>
    )
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <View style={{ flex: 1 }}>{children}</View>
      <View
        role="navigation"
        accessibilityLabel="Main menu"
        style={{
          flexDirection: "row",
          gap: 4,
          padding: 4,
          paddingBottom: 4 + insets.bottom,
          borderTopWidth: 1,
          borderColor: theme.colors.outlineVariant,
          backgroundColor: theme.colors.surface,
        }}
      >
        {list.map((item) => (
          <View key={item.key} style={{ flex: 1 }}>
            {item}
          </View>
        ))}
      </View>
    </View>
  )
}
