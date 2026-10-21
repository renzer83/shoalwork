import { ScrollView, View } from "react-native"
import { ActivityIndicator, useTheme } from "react-native-paper"
import { AppBar } from "../components/AppBar.js"
import { BotCard } from "../components/bot/BotCard.js"
import { EmptyState } from "../components/EmptyState.js"
import { ErrorBanner } from "../components/ErrorBanner.js"
import { useBots } from "../hooks/useBots.js"

export interface BotsScreenProps {
  // Receives the Bot's id; the route resolves it.
  readonly onOpenBot?: (id: string) => void
}

// Every Bot with its live state (bot.state_changed) and the cost of the last 24 h.
export function BotsScreen({ onOpenBot }: BotsScreenProps) {
  const theme = useTheme()
  const { load, reload } = useBots()
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <AppBar title="Bots" onRefresh={reload} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        {load.kind === "loading" ? <ActivityIndicator accessibilityLabel="Loading" /> : null}
        {load.kind === "failed" ? (
          <ErrorBanner message={`Could not load the Bots (HTTP ${load.status})`} onRetry={reload} />
        ) : null}
        {load.kind === "loaded" && load.rows.length === 0 ? <EmptyState title="No Bots yet" /> : null}
        {load.kind === "loaded"
          ? load.rows.map((row) => (
              <BotCard key={row.id} bot={row} {...(onOpenBot ? { onOpen: onOpenBot } : {})} />
            ))
          : null}
      </ScrollView>
    </View>
  )
}
