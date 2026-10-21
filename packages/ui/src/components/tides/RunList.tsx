import { View } from "react-native"
import { Text } from "react-native-paper"
import { useTideRuns } from "../../hooks/useTides.js"
import { useLocale } from "../../i18n/index.js"

export interface RunListProps {
  readonly tideId: string
}

// The firings of one Tide, with the state of the task each one created.
export function RunList({ tideId }: RunListProps) {
  const { load } = useTideRuns(tideId)
  const { t } = useLocale()
  if (load.kind === "loading") {
    return <Text variant="bodySmall">{t("runs.loading")}</Text>
  }
  if (load.kind === "failed") {
    return <Text variant="bodySmall">{t("runs.failed", { status: load.status })}</Text>
  }
  if (load.rows.length === 0) {
    return <Text variant="bodySmall">{t("runs.empty")}</Text>
  }
  return (
    <View style={{ gap: 4 }}>
      {load.rows.map((row) => (
        <Text key={row.taskId} variant="bodySmall">
          {t("runs.line", { at: row.at, trigger: row.trigger, task: row.taskId, state: row.state })}
        </Text>
      ))}
    </View>
  )
}
