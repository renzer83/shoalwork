import { View } from "react-native"
import { Text, useTheme } from "react-native-paper"

export interface TankBadgeProps {
  readonly mode: "local" | "server"
  readonly host: string
}

// Where the Bot's executions run (the Tank). Text only: the icon font is not bundled.
export function TankBadge({ mode, host }: TankBadgeProps) {
  const theme = useTheme()
  return (
    <View
      accessibilityLabel={`Tank ${mode} on ${host}`}
      style={{
        alignSelf: "flex-start",
        borderRadius: 8,
        paddingHorizontal: 8,
        paddingVertical: 2,
        backgroundColor: theme.colors.secondaryContainer,
      }}
    >
      <Text variant="labelMedium" style={{ color: theme.colors.onSecondaryContainer }}>
        {`tank: ${mode} · ${host}`}
      </Text>
    </View>
  )
}
