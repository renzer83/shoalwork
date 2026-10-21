import type { MetricsCompare } from "@shoalwork/api-client"
import { View } from "react-native"
import { ActivityIndicator, Card, Text, useTheme } from "react-native-paper"
import { useLocale } from "../../i18n/index.js"
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
  const { t } = useLocale()
  return (
    <Card>
      <Card.Content style={{ gap: 6 }}>
        <Text variant="titleMedium">{t("metrics.title")}</Text>
        {load.kind === "loading" ? <ActivityIndicator accessibilityLabel={t("metrics.loading")} /> : null}
        {load.kind === "failed" ? (
          <ErrorBanner message={t("metrics.failed", { status: load.status })} onRetry={onRetry} />
        ) : null}
        {load.kind === "loaded" ? (
          <>
            <Text variant="labelSmall">
              {load.value.baselineAt === null
                ? t("metrics.noBaseline")
                : t("metrics.baselineFrom", { date: load.value.baselineAt })}
            </Text>
            {load.value.rows.map((row) => {
              const verdict =
                row.met === null ? t("metrics.noData") : row.met ? t("metrics.met") : t("metrics.missed")
              const color =
                row.met === null
                  ? theme.colors.onSurfaceVariant
                  : row.met
                    ? theme.colors.primary
                    : theme.colors.error
              return (
                <View
                  key={row.key}
                  accessibilityLabel={t("metrics.verdictLabel", { verdict, label: row.label })}
                  style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}
                >
                  <Text variant="bodySmall" style={{ flex: 1 }}>
                    {row.label}
                  </Text>
                  <Text variant="bodySmall" style={{ color }}>
                    {formatMetric(row.key, row.current, t)}
                  </Text>
                  <Text variant="bodySmall">
                    {t("metrics.base", { value: formatMetric(row.key, row.baseline, t) })}
                  </Text>
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
