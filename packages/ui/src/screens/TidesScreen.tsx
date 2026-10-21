import { Effect } from "effect"
import { useState } from "react"
import { ScrollView, View } from "react-native"
import { Text, useTheme } from "react-native-paper"
import { useApi } from "../api-context.js"
import { AppBar } from "../components/AppBar.js"
import { EmptyState } from "../components/EmptyState.js"
import { ErrorBanner } from "../components/ErrorBanner.js"
import { RunList } from "../components/tides/RunList.js"
import { TideForm } from "../components/tides/TideForm.js"
import { TideRow } from "../components/tides/TideRow.js"
import { TideAck, TideRan } from "../components/tides/tide-model.js"
import { failureText } from "../hooks/failure.js"
import { useBotNames } from "../hooks/useBotNames.js"
import { useTides } from "../hooks/useTides.js"
import { useLocale } from "../i18n/index.js"

// Every Tide with its Bot, on/off, a run-now, the runs of the one open, and the form that creates one.
export function TidesScreen() {
  const theme = useTheme()
  const { t } = useLocale()
  const { client } = useApi()
  const { load, reload } = useTides()
  const bots = useBotNames()
  const [openId, setOpenId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const botName = (botId: string): string => bots.find((bot) => bot.id === botId)?.name ?? botId

  const toggle = async (id: string, enabled: boolean) => {
    setNotice(null)
    const result = await Effect.runPromise(
      Effect.result(client.post(`/tides/${encodeURIComponent(id)}/enable`, { enabled: !enabled }, TideAck)),
    )
    if (result._tag === "Failure")
      setNotice(t("tides.changeFailed", { failure: failureText(result.failure, t) }))
    reload()
  }

  // A held-back run (409) says why: cooldown, cap, disabled, feedback.
  const runNow = async (id: string) => {
    setNotice(null)
    const result = await Effect.runPromise(
      Effect.result(client.post(`/tides/${encodeURIComponent(id)}/run`, {}, TideRan)),
    )
    setNotice(
      result._tag === "Success"
        ? t("tides.runStarted")
        : t("tides.runNotRun", { failure: failureText(result.failure, t) }),
    )
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <AppBar title={t("tides.title")} onRefresh={reload} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        {load.kind === "failed" ? (
          <ErrorBanner message={t("tides.loadFailed", { status: load.status })} onRetry={reload} />
        ) : null}
        {load.kind === "loaded" && load.rows.length === 0 ? <EmptyState title={t("tides.empty")} /> : null}
        {notice === null ? null : <Text variant="bodySmall">{notice}</Text>}
        {load.kind === "loaded"
          ? load.rows.map((tide) => (
              <View key={tide.id} style={{ gap: 8 }}>
                <TideRow
                  tide={tide}
                  botName={botName(tide.botId)}
                  onToggle={() => void toggle(tide.id, tide.enabled)}
                  onRun={() => void runNow(tide.id)}
                  onRuns={() => setOpenId(openId === tide.id ? null : tide.id)}
                />
                {openId === tide.id ? <RunList tideId={tide.id} /> : null}
              </View>
            ))
          : null}
        <TideForm onSaved={reload} />
      </ScrollView>
    </View>
  )
}
