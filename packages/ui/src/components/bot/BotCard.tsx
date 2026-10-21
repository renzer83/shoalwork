import type { BotSummary } from "@shoalwork/api-client"
import { Pressable, View } from "react-native"
import { Card, Text, useTheme } from "react-native-paper"

export interface BotCardProps {
  readonly bot: BotSummary & { readonly taskId?: string; readonly costUsd24h: number | undefined }
  readonly onOpen?: (id: string) => void
}

// One row of the Bots list: name, role, live state, the task in progress and the cost of the last 24 h.
export function BotCard({ bot, onOpen }: BotCardProps) {
  const theme = useTheme()
  const cost = bot.costUsd24h === undefined ? "—" : `$${bot.costUsd24h.toFixed(2)}`
  return (
    <Pressable accessibilityRole="button" onPress={() => onOpen?.(bot.id)}>
      <Card>
        <Card.Content style={{ gap: 4 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <Text variant="titleMedium">{bot.name}</Text>
            <Text variant="labelLarge" accessibilityLabel={`state ${bot.state}`}>
              {bot.state}
            </Text>
          </View>
          <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
            {bot.role}
          </Text>
          <Text variant="bodySmall">{`task: ${bot.taskId ?? "—"}`}</Text>
          <Text variant="bodySmall">{`cost 24 h: ${cost}`}</Text>
        </Card.Content>
      </Card>
    </Pressable>
  )
}
