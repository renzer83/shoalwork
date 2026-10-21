import { ScrollView, View } from "react-native"
import { ActivityIndicator, Text, useTheme } from "react-native-paper"
import { AppBar } from "../components/AppBar.js"
import { EmptyState } from "../components/EmptyState.js"
import { ErrorBanner } from "../components/ErrorBanner.js"
import { ExecutorCard } from "../components/executor/ExecutorCard.js"
import { useExecutors } from "../hooks/useExecutors.js"
import { useLocale } from "../i18n/index.js"

// The executors of this host: CLI and version against the pin, login per Bot, quota and quality (T-117).
export function ExecutorsScreen() {
  const theme = useTheme()
  const { t } = useLocale()
  const executors = useExecutors()
  const { load } = executors
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <AppBar title={t("executors.title")} onRefresh={executors.reload} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        {load.kind === "loading" ? <ActivityIndicator accessibilityLabel={t("executors.loading")} /> : null}
        {load.kind === "failed" ? <ErrorBanner message={load.message} onRetry={executors.reload} /> : null}
        {executors.probeFailure === null ? null : <ErrorBanner message={executors.probeFailure} />}
        {load.kind === "loaded" && load.value.length === 0 ? (
          <EmptyState title={t("executors.empty")} />
        ) : null}
        {load.kind === "loaded"
          ? load.value.map((executor) => (
              <ExecutorCard
                key={executor.id}
                executor={executor}
                probing={executors.probing === executor.id}
                onReprobe={executors.reprobe}
              />
            ))
          : null}
        {load.kind === "loaded" && load.value.length > 0 ? (
          <Text variant="bodySmall">{t("executors.footer")}</Text>
        ) : null}
      </ScrollView>
    </View>
  )
}
