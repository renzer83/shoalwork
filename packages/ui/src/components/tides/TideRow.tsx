import type { Tide } from "@shoalwork/contracts"
import { View } from "react-native"
import { Button, Card, Text, useTheme } from "react-native-paper"
import { scheduleText } from "./tide-model.js"

export interface TideRowProps {
  readonly tide: Tide
  readonly botName: string
  readonly onToggle: () => void
  readonly onRun: () => void
  readonly onRuns: () => void
}

// One Tide: its Bot, its schedule, whether it is on, and the three things the person does with it.
export function TideRow({ tide, botName, onToggle, onRun, onRuns }: TideRowProps) {
  const theme = useTheme()
  return (
    <Card>
      <Card.Content style={{ gap: 6 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Text variant="titleMedium">{tide.name}</Text>
          <Text variant="labelLarge">{tide.enabled ? "on" : "off"}</Text>
        </View>
        <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
          {`${botName} · ${scheduleText(tide)}`}
        </Text>
        <Text variant="bodySmall">{tide.taskTemplate.title}</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Button mode="outlined" onPress={onToggle}>
            {tide.enabled ? "Turn off" : "Turn on"}
          </Button>
          <Button mode="outlined" onPress={onRun}>
            Run now
          </Button>
          <Button mode="text" onPress={onRuns}>
            Runs
          </Button>
        </View>
      </Card.Content>
    </Card>
  )
}
