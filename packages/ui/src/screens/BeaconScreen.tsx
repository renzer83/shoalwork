import type { Event } from "@shoalwork/contracts"
import { type ReactNode, useState } from "react"
import { ScrollView, View } from "react-native"
import { ActivityIndicator, Button, Card, Text, useTheme } from "react-native-paper"
import { AppBar } from "../components/AppBar.js"
import {
  COST_DIMENSIONS,
  type CostDimension,
  EMPTY_FILTERS,
  type EventFilters as Filters,
  formatUsd,
  type PeriodKey,
  parseTypes,
} from "../components/beacon/beacon-model.js"
import { CostChart } from "../components/beacon/CostChart.js"
import { EventDetail } from "../components/beacon/EventDetail.js"
import { EventFilters } from "../components/beacon/EventFilters.js"
import { EventTable } from "../components/beacon/EventTable.js"
import { PeriodPicker } from "../components/beacon/PeriodPicker.js"
import { ReplayCompare } from "../components/beacon/ReplayCompare.js"
import { SavingsCards } from "../components/beacon/SavingsCards.js"
import { ErrorBanner } from "../components/ErrorBanner.js"
import { useBeaconEvents } from "../hooks/useBeaconEvents.js"
import { useBeaconSummary } from "../hooks/useBeaconSummary.js"
import { useReplay } from "../hooks/useReplay.js"

export interface BeaconScreenProps {
  // Opens the Bot of a bot stream from the event detail.
  readonly onOpenBot?: ((botId: string) => void) | undefined
}

function Panel({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <Card>
      <Card.Content style={{ gap: 12 }}>
        <Text variant="titleMedium">{title}</Text>
        {children}
      </Card.Content>
    </Card>
  )
}

// The Farol: savings, cost by day and by dimension, and the event log with filters and live feed (T-121).
export function BeaconScreen({ onOpenBot }: BeaconScreenProps) {
  const theme = useTheme()
  const [period, setPeriod] = useState<PeriodKey>("7d")
  const [by, setBy] = useState<CostDimension>("tier")
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS)
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS)
  const [selected, setSelected] = useState<Event | null>(null)
  const summary = useBeaconSummary(period, by)
  const feed = useBeaconEvents(applied, period)
  const replay = useReplay()
  const unknownTypes = parseTypes(draft.types).unknown

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <AppBar
        title="Farol"
        onRefresh={() => {
          summary.reload()
          feed.reload()
        }}
      />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        <PeriodPicker value={period} onChange={setPeriod} />

        <Panel title="Economia do período">
          {summary.savings.kind === "loading" ? (
            <ActivityIndicator accessibilityLabel="Loading savings" />
          ) : null}
          {summary.savings.kind === "failed" ? (
            <ErrorBanner message={summary.savings.message} onRetry={summary.reload} />
          ) : null}
          {summary.savings.kind === "loaded" ? <SavingsCards report={summary.savings.value} /> : null}
        </Panel>

        <Panel title="Custo">
          {summary.daily.kind === "failed" ? (
            <ErrorBanner message={summary.daily.message} onRetry={summary.reload} />
          ) : null}
          {summary.daily.kind === "loaded" ? (
            <CostChart
              title="Custo por dia (USD)"
              bars={summary.daily.value.days.map((day) => ({ label: day.day, value: day.usd }))}
            />
          ) : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {COST_DIMENSIONS.map((dimension) => (
              <Button
                key={dimension.key}
                mode={dimension.key === by ? "contained" : "outlined"}
                onPress={() => setBy(dimension.key)}
              >
                {dimension.label}
              </Button>
            ))}
          </View>
          {summary.costs.kind === "failed" ? (
            <ErrorBanner message={summary.costs.message} onRetry={summary.reload} />
          ) : null}
          {summary.costs.kind === "loaded" ? (
            <>
              <CostChart
                title={`Custo por ${by}`}
                bars={summary.costs.value.rows.map((row) => ({ label: row.key, value: row.usd }))}
                height={80}
              />
              {summary.costs.value.rows.map((row) => (
                <Text key={row.key} variant="bodySmall">
                  {`${row.key} · ${row.n} execuções · ${row.tokensIn} tokens in · ${formatUsd(row.usd)}`}
                </Text>
              ))}
            </>
          ) : null}
        </Panel>

        <Panel title="Eventos">
          <EventFilters
            draft={draft}
            onChange={setDraft}
            onApply={() => {
              setApplied(draft)
              setSelected(null)
            }}
          />
          {unknownTypes.length > 0 ? (
            <Text variant="bodySmall">{`Tipos desconhecidos: ${unknownTypes.join(", ")}`}</Text>
          ) : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Button mode="outlined" onPress={() => feed.setLive(!feed.live)}>
              {feed.live ? "Pausar ao vivo" : "Retomar ao vivo"}
            </Button>
            <Button mode="outlined" onPress={feed.reload}>
              Recarregar
            </Button>
          </View>
          {feed.load.kind === "loading" ? <ActivityIndicator accessibilityLabel="Loading events" /> : null}
          {feed.load.kind === "failed" ? (
            <ErrorBanner message={feed.load.message} onRetry={feed.reload} />
          ) : null}
          {feed.load.kind === "loaded" ? (
            <>
              <EventTable
                events={feed.load.page.events}
                selectedId={selected?.id ?? null}
                onSelect={setSelected}
              />
              {feed.load.page.nextBefore === null ? null : (
                <Button onPress={feed.loadMore} disabled={feed.load.loadingOlder}>
                  Carregar mais
                </Button>
              )}
            </>
          ) : null}
          <EventDetail event={selected} onOpenBot={onOpenBot} onReplay={(taskId) => replay.start(taskId)} />
          {replay.load.kind === "starting" ? (
            <ActivityIndicator accessibilityLabel="Starting replay" />
          ) : null}
          {replay.load.kind === "failed" ? <ErrorBanner message={replay.load.message} /> : null}
          {replay.load.kind === "loaded" ? (
            <ReplayCompare
              comparison={replay.load.comparison}
              onRefresh={replay.refresh}
              onClose={replay.close}
            />
          ) : null}
        </Panel>
      </ScrollView>
    </View>
  )
}
