import { ScrollView, View } from "react-native"
import { Text, useTheme } from "react-native-paper"
import { AppBar } from "../components/AppBar.js"
import { ConnectorCard } from "../components/currents/ConnectorCard.js"
import { KIND_ORDER, KIND_TITLE } from "../components/currents/currents-model.js"
import { McpForm } from "../components/currents/McpForm.js"
import { EmptyState } from "../components/EmptyState.js"
import { ErrorBanner } from "../components/ErrorBanner.js"
import { useConnectors } from "../hooks/useCurrents.js"

export interface CurrentsScreenProps {
  // Receives the connector's id; the route resolves it.
  readonly onOpenConnector?: (id: string) => void
}

// The catalog of connectors, grouped by kind, and the form that adds an MCP server.
export function CurrentsScreen({ onOpenConnector }: CurrentsScreenProps) {
  const theme = useTheme()
  const { load, reload } = useConnectors()
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <AppBar title="Correntes" onRefresh={reload} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        {load.kind === "failed" ? (
          <ErrorBanner message={`Could not load the connectors (HTTP ${load.status})`} onRetry={reload} />
        ) : null}
        {load.kind === "loaded" && load.rows.length === 0 ? <EmptyState title="No connectors" /> : null}
        {load.kind === "loaded"
          ? KIND_ORDER.map((kind) => {
              const rows = load.rows.filter((row) => row.kind === kind)
              if (rows.length === 0) return null
              return (
                <View key={kind} style={{ gap: 8 }}>
                  <Text variant="titleSmall">{KIND_TITLE[kind]}</Text>
                  {rows.map((row) => (
                    <ConnectorCard
                      key={row.id}
                      connector={row}
                      {...(onOpenConnector ? { onOpen: onOpenConnector } : {})}
                    />
                  ))}
                </View>
              )
            })
          : null}
        <McpForm onSaved={reload} />
      </ScrollView>
    </View>
  )
}
