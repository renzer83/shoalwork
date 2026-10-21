import { Pressable, ScrollView, View } from "react-native"
import { ActivityIndicator, Card, Text, useTheme } from "react-native-paper"
import { AppBar } from "../components/AppBar.js"
import { EmptyState } from "../components/EmptyState.js"
import { ErrorBanner } from "../components/ErrorBanner.js"
import { HEALTH_KEY } from "../components/project/project-model.js"
import { useProjects } from "../hooks/useProjects.js"
import { useLocale } from "../i18n/index.js"

export interface ProjectsScreenProps {
  // Receives the project's slug; the route opens its board.
  readonly onOpenProject?: (slug: string) => void
}

// Every project with its health: attention when a task is blocked, running when work is in flight.
export function ProjectsScreen({ onOpenProject }: ProjectsScreenProps) {
  const theme = useTheme()
  const { t } = useLocale()
  const { load, reload } = useProjects()
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <AppBar title={t("projects.title")} onRefresh={reload} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        {load.kind === "loading" ? <ActivityIndicator accessibilityLabel={t("common.loading")} /> : null}
        {load.kind === "failed" ? (
          <ErrorBanner message={t("projects.loadFailed", { status: load.status })} onRetry={reload} />
        ) : null}
        {load.kind === "loaded" && load.rows.length === 0 ? <EmptyState title={t("projects.empty")} /> : null}
        {load.kind === "loaded"
          ? load.rows.map((row) => (
              <Pressable key={row.slug} accessibilityRole="button" onPress={() => onOpenProject?.(row.slug)}>
                <Card>
                  <Card.Content style={{ gap: 4 }}>
                    <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                      <Text variant="titleMedium">{row.name}</Text>
                      <Text
                        variant="labelLarge"
                        accessibilityLabel={t("projects.healthLabel", { health: t(HEALTH_KEY[row.health]) })}
                      >
                        {t(HEALTH_KEY[row.health])}
                      </Text>
                    </View>
                    <Text variant="bodySmall">{row.slug}</Text>
                    <Text variant="bodySmall">
                      {t("projects.counts", {
                        total: row.counts.total,
                        running: row.counts.running,
                        blocked: row.counts.blocked,
                      })}
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
