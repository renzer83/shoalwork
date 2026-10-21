import type { ReplayComparison, RunSummary } from "@shoalwork/api-client"
import { View } from "react-native"
import { Button, Text, useTheme } from "react-native-paper"
import { type Translate, useLocale } from "../../i18n/index.js"
import { formatDuration, formatUsd, formatUsdDelta } from "./beacon-model.js"

export interface ReplayCompareProps {
  readonly comparison: ReplayComparison
  readonly onRefresh?: (() => void) | undefined
  readonly onClose?: (() => void) | undefined
}

const verdictOf = (run: RunSummary, t: Translate): string =>
  run.verdict?.kind ?? t("beacon.replay.noVerdict", { state: run.state })

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

const overridesText = (comparison: ReplayComparison, t: Translate): string => {
  const parts = Object.entries(comparison.overrides).map(([key, value]) => `${key}=${String(value)}`)
  return parts.length === 0 ? t("common.none") : parts.join(" · ")
}

// A replay next to its source (T-122): verdict, cost, time, executor and model, and what only one of the runs did.
// Everything shown comes from the log, so it is printed as plain text and never interpreted.
export function ReplayCompare({ comparison, onRefresh, onClose }: ReplayCompareProps) {
  const theme = useTheme()
  const { t } = useLocale()
  const { source, replay, diff } = comparison
  const finished = replay.verdict !== null
  return (
    <View
      accessibilityLabel={t("beacon.replay.a11y")}
      style={{ gap: 8, borderColor: theme.colors.outline, borderWidth: 1, borderRadius: 8, padding: 12 }}
    >
      <Text variant="titleSmall">{t("beacon.replay.title")}</Text>
      <Text variant="bodySmall" selectable>{`${comparison.sourceTaskId} → ${comparison.newTaskId}`}</Text>
      <Text variant="bodySmall">
        {t("beacon.replay.overrides", { overrides: overridesText(comparison, t) })}
      </Text>
      <Text variant="bodySmall">
        {t("beacon.replay.base", {
          base: comparison.baseSha === null ? t("beacon.replay.branchTip") : comparison.baseSha.slice(0, 12),
          context: comparison.contextFrozen ? t("beacon.replay.frozen") : t("beacon.replay.rebuilt"),
        })}
      </Text>
      <Row label="" source={t("beacon.replay.original")} replay={t("beacon.replay.title")} />
      <Row label={t("beacon.replay.verdict")} source={verdictOf(source, t)} replay={verdictOf(replay, t)} />
      <Row
        label={t("beacon.replay.cost")}
        source={formatUsd(source.usage.usd)}
        replay={formatUsd(replay.usage.usd)}
      />
      <Row
        label={t("beacon.replay.duration")}
        source={formatDuration(source.durationMs)}
        replay={formatDuration(replay.durationMs)}
      />
      <Row
        label={t("beacon.replay.executor")}
        source={source.executor ?? "—"}
        replay={replay.executor ?? "—"}
      />
      <Row label={t("beacon.replay.model")} source={source.model ?? "—"} replay={replay.model ?? "—"} />
      {finished ? (
        <Text variant="bodyMedium">
          {t("beacon.replay.delta", {
            verdict: diff.verdictChanged ? t("beacon.replay.changed") : t("beacon.replay.same"),
            cost: formatUsdDelta(diff.usdDelta),
            time: formatDuration(diff.durationDeltaMs),
          })}
        </Text>
      ) : (
        <Text variant="bodyMedium">{t("beacon.replay.notFinished")}</Text>
      )}
      <Names title={t("beacon.replay.filesOnlySource")} items={diff.filesOnlyInSource} />
      <Names title={t("beacon.replay.filesOnlyReplay")} items={diff.filesOnlyInReplay} />
      <Names title={t("beacon.replay.evidenceOnlySource")} items={diff.evidenceOnlyInSource} />
      <Names title={t("beacon.replay.evidenceOnlyReplay")} items={diff.evidenceOnlyInReplay} />
      {comparison.notes.map((note) => (
        <Text key={note} variant="bodySmall">
          {note}
        </Text>
      ))}
      <View style={{ flexDirection: "row", gap: 8 }}>
        {onRefresh === undefined ? null : (
          <Button mode="outlined" onPress={onRefresh}>
            {t("beacon.replay.refresh")}
          </Button>
        )}
        {onClose === undefined ? null : <Button onPress={onClose}>{t("beacon.replay.close")}</Button>}
      </View>
    </View>
  )
}
