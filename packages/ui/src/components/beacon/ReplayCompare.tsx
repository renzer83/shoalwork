import type { ReplayComparison, RunSummary } from "@shoalwork/api-client"
import { View } from "react-native"
import { Button, Text, useTheme } from "react-native-paper"
import { formatDuration, formatUsd, formatUsdDelta } from "./beacon-model.js"

export interface ReplayCompareProps {
  readonly comparison: ReplayComparison
  readonly onRefresh?: (() => void) | undefined
  readonly onClose?: (() => void) | undefined
}

const verdictOf = (run: RunSummary): string => run.verdict?.kind ?? `sem veredito (${run.state})`

function Row({
  label,
  source,
  replay,
}: {
  readonly label: string
  readonly source: string
  readonly replay: string
}) {
  return (
    <View accessibilityRole="none" style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
      <Text variant="labelMedium" style={{ width: 96 }}>
        {label}
      </Text>
      <Text variant="bodySmall" selectable style={{ flex: 1, minWidth: 120 }}>
        {source}
      </Text>
      <Text variant="bodySmall" selectable style={{ flex: 1, minWidth: 120 }}>
        {replay}
      </Text>
    </View>
  )
}

function Names({ title, items }: { readonly title: string; readonly items: ReadonlyArray<string> }) {
  if (items.length === 0) return null
  return (
    <View style={{ gap: 2 }}>
      <Text variant="labelMedium">{title}</Text>
      {items.map((item) => (
        <Text key={item} variant="bodySmall" selectable style={{ fontFamily: "monospace" }}>
          {item}
        </Text>
      ))}
    </View>
  )
}

const overridesText = (comparison: ReplayComparison): string => {
  const parts = Object.entries(comparison.overrides).map(([key, value]) => `${key}=${String(value)}`)
  return parts.length === 0 ? "nenhum" : parts.join(" · ")
}

// A replay next to its source (T-122): verdict, cost, time, executor and model, and what only one of the runs did.
// Everything shown comes from the log, so it is printed as plain text and never interpreted.
export function ReplayCompare({ comparison, onRefresh, onClose }: ReplayCompareProps) {
  const theme = useTheme()
  const { source, replay, diff } = comparison
  const finished = replay.verdict !== null
  return (
    <View
      accessibilityLabel="Comparação do replay"
      style={{ gap: 8, borderColor: theme.colors.outline, borderWidth: 1, borderRadius: 8, padding: 12 }}
    >
      <Text variant="titleSmall">Replay</Text>
      <Text variant="bodySmall" selectable>{`${comparison.sourceTaskId} → ${comparison.newTaskId}`}</Text>
      <Text variant="bodySmall">{`Overrides: ${overridesText(comparison)}`}</Text>
      <Text variant="bodySmall">
        {`Base: ${comparison.baseSha === null ? "ponta do branch" : comparison.baseSha.slice(0, 12)} · Contexto: ${
          comparison.contextFrozen ? "congelado" : "remontado"
        }`}
      </Text>
      <Row label="" source="Original" replay="Replay" />
      <Row label="Veredito" source={verdictOf(source)} replay={verdictOf(replay)} />
      <Row label="Custo" source={formatUsd(source.usage.usd)} replay={formatUsd(replay.usage.usd)} />
      <Row
        label="Duração"
        source={formatDuration(source.durationMs)}
        replay={formatDuration(replay.durationMs)}
      />
      <Row label="Executor" source={source.executor ?? "—"} replay={replay.executor ?? "—"} />
      <Row label="Modelo" source={source.model ?? "—"} replay={replay.model ?? "—"} />
      {finished ? (
        <Text variant="bodyMedium">
          {`${diff.verdictChanged ? "O veredito mudou" : "Mesmo veredito"} · custo ${formatUsdDelta(
            diff.usdDelta,
          )} · tempo ${formatDuration(diff.durationDeltaMs)}`}
        </Text>
      ) : (
        <Text variant="bodyMedium">O replay ainda não terminou.</Text>
      )}
      <Names title="Arquivos só no original" items={diff.filesOnlyInSource} />
      <Names title="Arquivos só no replay" items={diff.filesOnlyInReplay} />
      <Names title="Evidências só no original" items={diff.evidenceOnlyInSource} />
      <Names title="Evidências só no replay" items={diff.evidenceOnlyInReplay} />
      {comparison.notes.map((note) => (
        <Text key={note} variant="bodySmall">
          {note}
        </Text>
      ))}
      <View style={{ flexDirection: "row", gap: 8 }}>
        {onRefresh === undefined ? null : (
          <Button mode="outlined" onPress={onRefresh}>
            Atualizar comparação
          </Button>
        )}
        {onClose === undefined ? null : <Button onPress={onClose}>Fechar</Button>}
      </View>
    </View>
  )
}
