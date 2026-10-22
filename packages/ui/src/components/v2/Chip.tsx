import type { ReactNode } from "react"
import { Text, View } from "react-native"
import { tokens } from "../../theme.js"

export interface ChipProps {
  readonly label: string
  readonly icon?: ReactNode
  readonly mono?: boolean
  readonly color?: string
  readonly background?: string
}

// A small rounded tag: the `ObraBoss`, `claude-code`, `sonnet-4.5` row of the chat header.
export function Chip({
  label,
  icon,
  mono = false,
  color = tokens.color.textSecondary,
  background,
}: ChipProps) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: tokens.radius.chip,
        borderWidth: 1,
        borderColor: tokens.color.border,
        backgroundColor: background ?? tokens.color.surface,
      }}
    >
      {icon}
      <Text
        numberOfLines={1}
        style={{ color, fontSize: 14, fontFamily: mono ? tokens.font.mono : undefined }}
      >
        {label}
      </Text>
    </View>
  )
}
