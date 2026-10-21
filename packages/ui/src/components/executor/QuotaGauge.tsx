import { View } from "react-native"
import { Text, useTheme } from "react-native-paper"
import { gaugeTone, percentText } from "./executor-model.js"

export interface QuotaGaugeProps {
  // 0..1: the share of the subscription window already used (QuotaStatus.usedRatio).
  readonly usedRatio: number
  readonly available: boolean
  // ISO-8601 UTC when the window closes, if the executor has one.
  readonly windowEndsAt?: string | undefined
}

// The window's usage as a bar; from 80% it turns red and says so in words too.
export function QuotaGauge({ usedRatio, available, windowEndsAt }: QuotaGaugeProps) {
  const theme = useTheme()
  const tone = gaugeTone(usedRatio)
  const color = tone === "alert" ? theme.colors.error : theme.colors.primary
  const width = `${Math.min(100, Math.max(0, usedRatio * 100))}%` as const
  return (
    <View style={{ gap: 4 }}>
      <Text variant="bodySmall">{`Cota usada: ${percentText(usedRatio)}${available ? "" : " · indisponível"}`}</Text>
      <View
        testID="quota-track"
        style={{
          height: 8,
          borderRadius: 4,
          backgroundColor: theme.colors.surfaceVariant,
          overflow: "hidden",
        }}
      >
        <View testID="quota-fill" style={{ height: 8, width, backgroundColor: color }} />
      </View>
      {tone === "alert" ? (
        <Text variant="bodySmall" style={{ color: theme.colors.error }}>
          {`Atenção: ${percentText(usedRatio)} da janela já usados`}
        </Text>
      ) : null}
      {windowEndsAt === undefined ? null : <Text variant="bodySmall">{`Janela até ${windowEndsAt}`}</Text>}
    </View>
  )
}
