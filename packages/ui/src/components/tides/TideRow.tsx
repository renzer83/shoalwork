import type { Tide } from "@shoalwork/contracts"
import { View } from "react-native"
import { Button, Card, Text, useTheme } from "react-native-paper"
import { useLocale } from "../../i18n/index.js"
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
  const { t } = useLocale()
  return (
    <Card>
      <Card.Content style={{ gap: 6 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Text variant="titleMedium">{tide.name}</Text>
          <Text variant="labelLarge">{tide.enabled ? t("tides.on") : t("tides.off")}</Text>
        </View>
        <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
          {`${botName} · ${scheduleText(tide, t)}`}
        </Text>
        <Text variant="bodySmall">{tide.taskTemplate.title}</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Button mode="outlined" onPress={onToggle}>
            {tide.enabled ? t("tides.turnOff") : t("tides.turnOn")}
          </Button>
          <Button mode="outlined" onPress={onRun}>
            {t("tides.runNow")}
          </Button>
          <Button mode="text" onPress={onRuns}>
            {t("tides.runs")}
          </Button>
        </View>
      </Card.Content>
    </Card>
  )
}
