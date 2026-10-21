import { ScrollView, View } from "react-native"
import { ActivityIndicator, Card, Text, useTheme } from "react-native-paper"
import { AppBar } from "../components/AppBar.js"
import { EmptyState } from "../components/EmptyState.js"
import { ErrorBanner } from "../components/ErrorBanner.js"
import { usePods } from "../hooks/usePods.js"
import { useLocale } from "../i18n/index.js"
import { money, startedAgo } from "./pod-format.js"

export interface PodsScreenProps {
  // Receives the Pod's id; the route opens /pods/<id>.
  readonly onOpenPod?: (id: string) => void
}

// The Pods of the plans: name, steps finished out of the total, cost and when they started.
export function PodsScreen({ onOpenPod }: PodsScreenProps) {
  const theme = useTheme()
  const { t } = useLocale()
  const { load, reload } = usePods()
  const now = Date.now()
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <AppBar title={t("pods.title")} onRefresh={reload} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        {load.kind === "loading" ? <ActivityIndicator accessibilityLabel={t("common.loading")} /> : null}
        {load.kind === "failed" ? (
          <ErrorBanner message={t("pods.loadFailed", { status: load.status })} onRetry={reload} />
        ) : null}
        {load.kind === "loaded" && load.pods.length === 0 ? <EmptyState title={t("pods.empty")} /> : null}
        {load.kind === "loaded"
          ? load.pods.map((pod) => (
              <Card
                key={pod.id}
                mode="elevated"
                {...(onOpenPod === undefined ? {} : { onPress: () => onOpenPod(pod.id) })}
              >
                <Card.Title
                  title={pod.name}
                  subtitle={pod.state === "open" ? t("pods.open") : t("pods.closed")}
                />
                <Card.Content>
                  <Text variant="bodyMedium">
                    {t("pods.steps", {
                      done: pod.stepsDone,
                      total: pod.stepsTotal,
                      money: money(pod.costUsd),
                    })}
                  </Text>
                  <Text variant="bodySmall">
                    {t("pods.started", { ago: startedAgo(pod.createdAt, now, t) })}
                  </Text>
                </Card.Content>
              </Card>
            ))
          : null}
      </ScrollView>
    </View>
  )
}
