import type { SavingsReport } from "@shoalwork/api-client"
import { View } from "react-native"
import { Card, Text } from "react-native-paper"
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
  const local = report.decisions.rule + report.decisions.cache
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <Metric
        label="Decisões locais"
        value={formatPct(report.decisions.localPct)}
        detail={`${local} de ${report.decisions.total} sem chamar modelo`}
      />
      <Metric
        label="USD evitado (decisões)"
        value={formatUsd(report.avoidedUsd)}
        detail={`${report.haikuRuns} execuções Haiku · ${formatUsd(report.decisionUsd)} por decisão`}
      />
      <Metric
        label="Contexto cortado"
        value={formatPct(report.context.cutPct)}
        detail={`${report.context.tokensCut} tokens em ${report.context.assembled} montagens`}
      />
      <Metric
        label="USD evitado (contexto)"
        value={formatUsd(report.context.avoidedUsd)}
        detail={`${report.context.droppedItems} itens descartados pelo orçamento`}
      />
    </View>
  )
}
