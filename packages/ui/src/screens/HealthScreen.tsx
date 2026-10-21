import { type HealthBody, HttpError } from "@shoalwork/api-client"
import { Effect } from "effect"
import { useCallback, useEffect, useState } from "react"
import { ScrollView, View } from "react-native"
import { ActivityIndicator, Button, Card, Text, useTheme } from "react-native-paper"
import { useApi } from "../api-context.js"
import { AppBar } from "../components/AppBar.js"
import { ErrorBanner } from "../components/ErrorBanner.js"

type HealthState =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly health: HealthBody }
  | { readonly kind: "failed"; readonly message: string }

const describeFailure = (error: unknown, baseUrl: string): string => {
  if (error instanceof HttpError) {
    return error.status === 0
      ? `Cannot reach the core at ${baseUrl}`
      : `The core answered HTTP ${error.status}`
  }
  return "The core answered with an unexpected body"
}

export interface HealthScreenProps {
  readonly onOpenSetup?: () => void
}

export function HealthScreen({ onOpenSetup }: HealthScreenProps) {
  const { client, config, ready } = useApi()
  const theme = useTheme()
  const [state, setState] = useState<HealthState>({ kind: "loading" })

  const load = useCallback(() => {
    setState({ kind: "loading" })
    void Effect.runPromise(Effect.result(client.health())).then((result) => {
      setState(
        result._tag === "Success"
          ? { kind: "loaded", health: result.success }
          : { kind: "failed", message: describeFailure(result.failure, config.baseUrl) },
      )
    })
  }, [client, config.baseUrl])

  useEffect(() => {
    if (ready) {
      load()
    }
  }, [ready, load])

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <AppBar title="Health" onRefresh={load} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        <Text variant="bodySmall">{config.baseUrl}</Text>
        {state.kind === "loading" ? <ActivityIndicator accessibilityLabel="Loading" /> : null}
        {state.kind === "failed" ? <ErrorBanner message={state.message} onRetry={load} /> : null}
        {state.kind === "loaded" ? (
          <Card>
            <Card.Content style={{ gap: 4 }}>
              <Text variant="titleLarge">{state.health.ok ? "Core is up" : "Core is degraded"}</Text>
              <Text>{`ok: ${state.health.ok ? "yes" : "no"}`}</Text>
              <Text>{`db: ${state.health.db}`}</Text>
              <Text>{`version: ${state.health.version}`}</Text>
              <Text>{`uptime: ${state.health.uptimeSeconds}s`}</Text>
            </Card.Content>
          </Card>
        ) : null}
        {onOpenSetup === undefined ? null : <Button onPress={onOpenSetup}>Connection settings</Button>}
      </ScrollView>
    </View>
  )
}
