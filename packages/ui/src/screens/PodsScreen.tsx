import { ScrollView, View } from "react-native"
import { ActivityIndicator, Card, Text, useTheme } from "react-native-paper"
import { AppBar } from "../components/AppBar.js"
import { EmptyState } from "../components/EmptyState.js"
import { ErrorBanner } from "../components/ErrorBanner.js"
import { usePods } from "../hooks/usePods.js"
import { money, startedAgo } from "./pod-format.js"

export interface PodsScreenProps {
  // Receives the Pod's id; the route opens /pods/<id>.
  readonly onOpenPod?: (id: string) => void
}

// The Pods of the plans: name, steps finished out of the total, cost and when they started.
export function PodsScreen({ onOpenPod }: PodsScreenProps) {
  const theme = useTheme()
  const { load, reload } = usePods()
  const now = Date.now()
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <AppBar title="Times" onRefresh={reload} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        {load.kind === "loading" ? <ActivityIndicator accessibilityLabel="Loading" /> : null}
        {load.kind === "failed" ? (
          <ErrorBanner message={`Could not load the Pods (HTTP ${load.status})`} onRetry={reload} />
        ) : null}
        {load.kind === "loaded" && load.pods.length === 0 ? <EmptyState title="No Pods yet" /> : null}
        {load.kind === "loaded"
          ? load.pods.map((pod) => (
              <Card
                key={pod.id}
                mode="elevated"
                {...(onOpenPod === undefined ? {} : { onPress: () => onOpenPod(pod.id) })}
              >
                <Card.Title title={pod.name} subtitle={pod.state === "open" ? "open" : "closed"} />
                <Card.Content>
                  <Text variant="bodyMedium">{`${pod.stepsDone}/${pod.stepsTotal} steps · ${money(pod.costUsd)}`}</Text>
                  <Text variant="bodySmall">{`started ${startedAgo(pod.createdAt, now)}`}</Text>
                </Card.Content>
              </Card>
            ))
          : null}
      </ScrollView>
    </View>
  )
}
