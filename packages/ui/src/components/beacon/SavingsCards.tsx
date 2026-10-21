import type { SavingsReport } from "@shoalwork/api-client"
import { View } from "react-native"
import { Card, Text } from "react-native-paper"
import { useLocale } from "../../i18n/index.js"
import { formatPct, formatUsd } from "./beacon-model.js"

interface MetricProps {
  readonly label: string
  readonly value: string
  readonly detail: string
}

function Metric({ label, value, detail }: MetricProps) {
  return (
    <Card style={{ flexBasis: 220, flexGrow: 1 }}>
      <Card.Content style={{ gap: 4 }}>
        <Text variant="labelMedium">{label}</Text>
        <Text variant="headlineSmall">{value}</Text>
        <Text variant="bodySmall">{detail}</Text>
      </Card.Content>
    </Card>
  )
}

// What the local decisions and the compacted context saved in the period, from the log.
export function SavingsCards({ report }: { readonly report: SavingsReport }) {
  const { t } = useLocale()
  const local = report.decisions.rule + report.decisions.cache
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <Metric
        label={t("beacon.savings.local")}
        value={formatPct(report.decisions.localPct)}
        detail={t("beacon.savings.localDetail", { local, total: report.decisions.total })}
      />
      <Metric
        label={t("beacon.savings.usdDecisions")}
        value={formatUsd(report.avoidedUsd)}
        detail={t("beacon.savings.haikuDetail", {
          runs: report.haikuRuns,
          usd: formatUsd(report.decisionUsd),
        })}
      />
      <Metric
        label={t("beacon.savings.cut")}
        value={formatPct(report.context.cutPct)}
        detail={t("beacon.savings.cutDetail", {
          tokens: report.context.tokensCut,
          assembled: report.context.assembled,
        })}
      />
      <Metric
        label={t("beacon.savings.usdContext")}
        value={formatUsd(report.context.avoidedUsd)}
        detail={t("beacon.savings.droppedDetail", { count: report.context.droppedItems })}
      />
    </View>
  )
}
