import { Pressable } from "react-native"
import { Text, useTheme } from "react-native-paper"
import { useLocale } from "../i18n/index.js"
import type { NavEntry } from "./nav-entries.js"

export interface NavItemProps {
  readonly entry: NavEntry
  readonly active: boolean
  readonly onPress: (href: string) => void
}

const ACTIVATION_KEYS: ReadonlyArray<string> = ["Enter", " "]

// Role "button", not "link": react-native-web leaves Enter on a link to the browser, which only acts on <a href>, so
// a link role would not navigate from the keyboard. Enter and Space are handled here because react-native-web's
// keyup path does not call onPress for them.
export function NavItem({ entry, active, onPress }: NavItemProps) {
  const theme = useTheme()
  const { t } = useLocale()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t(entry.labelKey)}
      aria-current={active ? "page" : undefined}
      onPress={() => onPress(entry.href)}
      onKeyDown={(event) => {
        if (ACTIVATION_KEYS.includes(event.nativeEvent.key)) {
          onPress(entry.href)
        }
      }}
      style={({ pressed }) => ({
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderRadius: 8,
        minHeight: 44,
        justifyContent: "center",
        backgroundColor: active
          ? theme.colors.secondaryContainer
          : pressed
            ? theme.colors.surfaceVariant
            : "transparent",
      })}
    >
      <Text
        variant="titleSmall"
        style={{ color: active ? theme.colors.onSecondaryContainer : theme.colors.onSurface }}
      >
        {t(entry.labelKey)}
      </Text>
    </Pressable>
  )
}
