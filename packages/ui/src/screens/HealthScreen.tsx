import { type HealthBody, HttpError } from "@shoalwork/api-client"
import { Effect } from "effect"
import { useCallback, useEffect, useState } from "react"
import { ScrollView, View } from "react-native"
import { ActivityIndicator, Button, Card, Text, useTheme } from "react-native-paper"
import { useApi } from "../api-context.js"
import { AppBar } from "../components/AppBar.js"
import { ErrorBanner } from "../components/ErrorBanner.js"
import type { Translate } from "../i18n/index.js"
import { useLocale } from "../i18n/index.js"

type HealthState =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly health: HealthBody }
  | { readonly kind: "failed"; readonly message: string }

const describeFailure = (error: unknown, baseUrl: string, t: Translate): string => {
  if (error instanceof HttpError) {
    return error.status === 0
      ? t("common.cannotReachAt", { url: baseUrl })
      : t("common.httpAnswered", { status: error.status })
  }
  return t("common.unexpectedBody")
}

export interface HealthScreenProps {
  readonly onOpenSetup?: () => void
}

export function HealthScreen({ onOpenSetup }: HealthScreenProps) {
  const { client, config, ready } = useApi()
  const theme = useTheme()
  const { t } = useLocale()
  const [state, setState] = useState<HealthState>({ kind: "loading" })

  const load = useCallback(() => {
    setState({ kind: "loading" })
    void Effect.runPromise(Effect.result(client.health())).then((result) => {
      setState(
        result._tag === "Success"
          ? { kind: "loaded", health: result.success }
          : { kind: "failed", message: describeFailure(result.failure, config.baseUrl, t) },
      )
    })
  }, [client, config.baseUrl, t])

  useEffect(() => {
    if (ready) {
      load()
    }
  }, [ready, load])

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <AppBar title={t("health.title")} onRefresh={load} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        <Text variant="bodySmall">{config.baseUrl}</Text>
        {state.kind === "loading" ? <ActivityIndicator accessibilityLabel={t("common.loading")} /> : null}
        {state.kind === "failed" ? <ErrorBanner message={state.message} onRetry={load} /> : null}
        {state.kind === "loaded" ? (
          <Card>
            <Card.Content style={{ gap: 4 }}>
              <Text variant="titleLarge">{state.health.ok ? t("health.up") : t("health.degraded")}</Text>
              <Text>{t("health.ok", { value: state.health.ok ? t("common.yes") : t("common.no") })}</Text>
              <Text>{t("health.db", { db: state.health.db })}</Text>
              <Text>{t("health.version", { version: state.health.version })}</Text>
              <Text>{t("health.uptime", { seconds: state.health.uptimeSeconds })}</Text>
            </Card.Content>
          </Card>
        ) : null}
        {onOpenSetup === undefined ? null : <Button onPress={onOpenSetup}>{t("health.settings")}</Button>}
      </ScrollView>
    </View>
  )
}
