import { View } from "react-native"
import { Text, useTheme } from "react-native-paper"

export interface EventChipProps {
  readonly label: string
  readonly detail?: string
  readonly tone?: "neutral" | "good" | "bad"
}

// One line of progress between messages: a state change, a verdict or a folded run of commands and edits.
export function EventChip({ label, detail, tone = "neutral" }: EventChipProps) {
  const theme = useTheme()
  const color =
    tone === "bad" ? theme.colors.error : tone === "good" ? theme.colors.primary : theme.colors.secondary
  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={detail === undefined ? label : `${label}: ${detail}`}
      style={{
        alignSelf: "center",
        maxWidth: "95%",
        borderWidth: 1,
        borderColor: color,
        borderRadius: 16,
        paddingHorizontal: 12,
        paddingVertical: 4,
      }}
    >
      <Text numberOfLines={2} style={{ fontSize: 14, color }}>
        {detail === undefined ? label : `${label} · ${detail}`}
      </Text>
    </View>
  )
}
