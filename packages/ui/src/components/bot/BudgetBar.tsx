import { View } from "react-native"
import { Text, useTheme } from "react-native-paper"

export interface BudgetBarProps {
  readonly label: string
  readonly used: number
  readonly limit: number
  readonly unit: string
}

// used × limit as text and a bar. A limit of 0 has no room left; the bar never exceeds full width.
export function BudgetBar({ label, used, limit, unit }: BudgetBarProps) {
  const theme = useTheme()
  const ratio = limit <= 0 ? 1 : Math.min(used / limit, 1)
  const over = limit > 0 && used > limit
  return (
    <View style={{ gap: 4 }}>
      <Text variant="labelLarge">{`${label}: ${used.toFixed(2)} / ${limit} ${unit}`}</Text>
      <View
        style={{
          height: 8,
          borderRadius: 4,
          backgroundColor: theme.colors.surfaceVariant,
          overflow: "hidden",
        }}
      >
        <View
          accessibilityRole="progressbar"
          style={{
            height: 8,
            width: `${Math.round(ratio * 100)}%`,
            backgroundColor: over ? theme.colors.error : theme.colors.primary,
          }}
        />
      </View>
    </View>
  )
}
