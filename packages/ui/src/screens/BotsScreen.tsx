import { useState } from "react"
import { ScrollView, View } from "react-native"
import { ActivityIndicator, Button, useTheme } from "react-native-paper"
import { AppBar } from "../components/AppBar.js"
import { BotCard } from "../components/bot/BotCard.js"
import { EmptyState } from "../components/EmptyState.js"
import { ErrorBanner } from "../components/ErrorBanner.js"
import { useBots } from "../hooks/useBots.js"
import { useLocale } from "../i18n/index.js"

export interface BotsScreenProps {
  // Receives the Bot's id; the route resolves it.
  readonly onOpenBot?: (id: string) => void
}

// Every Bot with its live state (bot.state_changed) and the cost of the last 24 h. Archived Bots are hidden unless asked.
export function BotsScreen({ onOpenBot }: BotsScreenProps) {
  const theme = useTheme()
  const { t } = useLocale()
  const { load, reload } = useBots()
  const [showArchived, setShowArchived] = useState(false)
  const rows = load.kind === "loaded" ? load.rows : []
  const visible = showArchived ? rows : rows.filter((row) => row.state !== "archived")
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <AppBar title={t("bots.title")} onRefresh={reload} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        {load.kind === "loading" ? <ActivityIndicator accessibilityLabel={t("common.loading")} /> : null}
        {load.kind === "failed" ? (
          <ErrorBanner message={t("bots.loadFailed", { status: load.status })} onRetry={reload} />
        ) : null}
        {load.kind === "loaded" ? (
          <Button mode="text" onPress={() => setShowArchived((on) => !on)}>
            {showArchived ? t("bots.hideArchived") : t("bots.showArchived")}
          </Button>
        ) : null}
        {load.kind === "loaded" && rows.length === 0 ? <EmptyState title={t("bots.empty")} /> : null}
        {load.kind === "loaded" && rows.length > 0 && visible.length === 0 ? (
          <EmptyState title={t("bots.noneActive")} />
        ) : null}
        {visible.map((row) => (
          <BotCard key={row.id} bot={row} {...(onOpenBot ? { onOpen: onOpenBot } : {})} />
        ))}
      </ScrollView>
    </View>
  )
}
