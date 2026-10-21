import { View } from "react-native"
import { Text } from "react-native-paper"
import { useTideRuns } from "../../hooks/useTides.js"

export interface RunListProps {
  readonly tideId: string
}

// The firings of one Tide, with the state of the task each one created.
export function RunList({ tideId }: RunListProps) {
  const { load } = useTideRuns(tideId)
  if (load.kind === "loading") {
    return <Text variant="bodySmall">Loading runs…</Text>
  }
  if (load.kind === "failed") {
    return <Text variant="bodySmall">{`Could not load the runs (HTTP ${load.status})`}</Text>
  }
  if (load.rows.length === 0) {
    return <Text variant="bodySmall">No runs in the last 30 days</Text>
  }
  return (
    <View style={{ gap: 4 }}>
      {load.rows.map((row) => (
        <Text key={row.taskId} variant="bodySmall">
          {`${row.at} · ${row.trigger} · task ${row.taskId} · ${row.state}`}
        </Text>
      ))}
    </View>
  )
}
