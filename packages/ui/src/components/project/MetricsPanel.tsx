import type { MetricsCompare } from "@shoalwork/api-client"
import { View } from "react-native"
import { ActivityIndicator, Card, Text, useTheme } from "react-native-paper"
import { ErrorBanner } from "../ErrorBanner.js"
import { formatMetric } from "./project-model.js"

export type MetricsPanelLoad =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly value: MetricsCompare }
  | { readonly kind: "failed"; readonly status: number }

export interface MetricsPanelProps {
  readonly load: MetricsPanelLoad
  readonly onRetry: () => void
}

// The six measures against the baseline and the goal of index.md §2.3. Met goals use the primary colour.
export function MetricsPanel({ load, onRetry }: MetricsPanelProps) {
  const theme = useTheme()
  return (
    <Card>
      <Card.Content style={{ gap: 6 }}>
        <Text variant="titleMedium">Factory metrics vs baseline</Text>
        {load.kind === "loading" ? <ActivityIndicator accessibilityLabel="Loading metrics" /> : null}
        {load.kind === "failed" ? (
          <ErrorBanner message={`Could not load metrics (HTTP ${load.status})`} onRetry={onRetry} />
        ) : null}
        {load.kind === "loaded" ? (
          <>
            <Text variant="labelSmall">
              {load.value.baselineAt === null
                ? "No baseline computed for this project"
                : `Baseline from ${load.value.baselineAt}`}
            </Text>
            {load.value.rows.map((row) => {
              const verdict = row.met === null ? "no data" : row.met ? "goal met" : "goal missed"
              const color =
                row.met === null
                  ? theme.colors.onSurfaceVariant
                  : row.met
                    ? theme.colors.primary
                    : theme.colors.error
              return (
                <View
                  key={row.key}
                  accessibilityLabel={`${verdict}: ${row.label}`}
                  style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}
                >
                  <Text variant="bodySmall" style={{ flex: 1 }}>
                    {row.label}
                  </Text>
                  <Text variant="bodySmall" style={{ color }}>
                    {formatMetric(row.key, row.current)}
                  </Text>
                  <Text variant="bodySmall">{`base ${formatMetric(row.key, row.baseline)}`}</Text>
                  <Text variant="bodySmall">{row.target}</Text>
                </View>
              )
            })}
          </>
        ) : null}
      </Card.Content>
    </Card>
  )
}
