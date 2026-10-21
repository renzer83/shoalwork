import { Effect } from "effect"
import { useEffect, useState } from "react"
import { ScrollView, View } from "react-native"
import { Button, Card, Text, useTheme } from "react-native-paper"
import { useApi } from "../api-context.js"
import { AppBar } from "../components/AppBar.js"
import { ConnectorOne, KIND_LABEL } from "../components/currents/currents-model.js"
import { PermissionList } from "../components/currents/PermissionList.js"
import { EmptyState } from "../components/EmptyState.js"
import { ErrorBanner } from "../components/ErrorBanner.js"
import { failureText } from "../hooks/failure.js"
import { useBotNames } from "../hooks/useBotNames.js"
import { useConnectors, useConnectorUsage } from "../hooks/useCurrents.js"
import { useLocale } from "../i18n/index.js"

export interface ConnectorScreenProps {
  // The connector's id from the route: "github", "notion" or an MCP server id.
  readonly id: string
}

// One connector: its permissions, the Bots that use it (assignable), and its recent calls.
export function ConnectorScreen({ id }: ConnectorScreenProps) {
  const theme = useTheme()
  const { client } = useApi()
  const { t } = useLocale()
  const { load, reload } = useConnectors()
  const bots = useBotNames()
  const usage = useConnectorUsage(id)
  // Null until the person touches the list: the saved assignment is shown until then.
  const [picked, setPicked] = useState<ReadonlyArray<string> | null>(null)
  const [saveFailure, setSaveFailure] = useState<string | null>(null)
  const entry = load.kind === "loaded" ? load.rows.find((row) => row.id === id) : undefined
  const saved = entry?.bots.map((bot) => bot.name) ?? []
  const assigned = picked ?? saved

  useEffect(() => {
    setPicked(null)
  }, [id])

  const toggle = (name: string) =>
    setPicked((current) => {
      const base = current ?? saved
      return base.includes(name) ? base.filter((item) => item !== name) : [...base, name]
    })

  const save = async () => {
    setSaveFailure(null)
    const result = await Effect.runPromise(
      Effect.result(
        client.patch(`/connectors/${encodeURIComponent(id)}/bots`, { bots: assigned }, ConnectorOne),
      ),
    )
    if (result._tag === "Failure") {
      setSaveFailure(failureText(result.failure, t))
      return
    }
    setPicked(null)
    reload()
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <AppBar title={entry?.name ?? t("currents.connectorTitle")} onRefresh={reload} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        {load.kind === "failed" ? (
          <ErrorBanner message={t("currents.connectorFailed", { status: load.status })} onRetry={reload} />
        ) : null}
        {load.kind === "loaded" && entry === undefined ? (
          <EmptyState title={t("currents.connectorNotFound")} />
        ) : null}
        {entry === undefined ? null : (
          <Card>
            <Card.Content style={{ gap: 8 }}>
              <Text variant="titleMedium">{entry.name}</Text>
              <Text variant="bodySmall">{`${t(KIND_LABEL[entry.kind])} · ${t(entry.status === "enabled" ? "currents.statusEnabled" : "currents.statusDisabled")}`}</Text>
              <Text variant="titleSmall">{t("currents.permissions")}</Text>
              <PermissionList permissions={entry.permissions} />
            </Card.Content>
          </Card>
        )}
        {entry === undefined ? null : (
          <Card>
            <Card.Content style={{ gap: 8 }}>
              <Text variant="titleSmall">{t("currents.botsUsing")}</Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {bots.map((bot) => (
                  <Button
                    key={bot.id}
                    mode={assigned.includes(bot.name) ? "contained" : "outlined"}
                    onPress={() => toggle(bot.name)}
                  >
                    {bot.name}
                  </Button>
                ))}
              </View>
              {saveFailure === null ? null : (
                <Text variant="bodySmall">{t("currents.saveFailed", { failure: saveFailure })}</Text>
              )}
              <Button mode="contained" onPress={() => void save()}>
                {t("currents.saveBots")}
              </Button>
            </Card.Content>
          </Card>
        )}
        <Card>
          <Card.Content style={{ gap: 6 }}>
            <Text variant="titleSmall">{t("currents.recentCalls")}</Text>
            {usage.load.kind === "loaded" && usage.load.rows.length === 0 ? (
              <Text variant="bodySmall">{t("currents.noCalls")}</Text>
            ) : null}
            {usage.load.kind === "loaded"
              ? usage.load.rows.map((row) => (
                  <Text key={`${row.at}:${row.tool}:${row.botId}`} variant="bodySmall">
                    {t("currents.callLine", {
                      at: row.at,
                      tool: row.tool,
                      decision: row.decision,
                      failed: row.ok ? "" : t("currents.callFailed"),
                    })}
                  </Text>
                ))
              : null}
          </Card.Content>
        </Card>
      </ScrollView>
    </View>
  )
}
