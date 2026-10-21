import { Pressable, ScrollView, View } from "react-native"
import { ActivityIndicator, Card, Text, useTheme } from "react-native-paper"
import { AppBar } from "../components/AppBar.js"
import { EmptyState } from "../components/EmptyState.js"
import { ErrorBanner } from "../components/ErrorBanner.js"
import { useProjects } from "../hooks/useProjects.js"

export interface ProjectsScreenProps {
  // Receives the project's slug; the route opens its board.
  readonly onOpenProject?: (slug: string) => void
}

// Every project with its health: attention when a task is blocked, running when work is in flight.
export function ProjectsScreen({ onOpenProject }: ProjectsScreenProps) {
  const theme = useTheme()
  const { load, reload } = useProjects()
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <AppBar title="Projects" onRefresh={reload} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        {load.kind === "loading" ? <ActivityIndicator accessibilityLabel="Loading" /> : null}
        {load.kind === "failed" ? (
          <ErrorBanner message={`Could not load the projects (HTTP ${load.status})`} onRetry={reload} />
        ) : null}
        {load.kind === "loaded" && load.rows.length === 0 ? <EmptyState title="No projects yet" /> : null}
        {load.kind === "loaded"
          ? load.rows.map((row) => (
              <Pressable key={row.slug} accessibilityRole="button" onPress={() => onOpenProject?.(row.slug)}>
                <Card>
                  <Card.Content style={{ gap: 4 }}>
                    <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                      <Text variant="titleMedium">{row.name}</Text>
                      <Text variant="labelLarge" accessibilityLabel={`health ${row.health}`}>
                        {row.health}
                      </Text>
                    </View>
                    <Text variant="bodySmall">{row.slug}</Text>
                    <Text variant="bodySmall">
                      {`${row.counts.total} tasks · ${row.counts.running} running · ${row.counts.blocked} blocked`}
                    </Text>
                  </Card.Content>
                </Card>
              </Pressable>
            ))
          : null}
      </ScrollView>
    </View>
  )
}
