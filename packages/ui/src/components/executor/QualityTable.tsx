import { useState } from "react"
import { View } from "react-native"
import { Button, Text } from "react-native-paper"
import { formatPct, formatUsd } from "../beacon/beacon-model.js"
import {
  QUALITY_HEADERS,
  type QualityKey,
  type QualityRow,
  type SortDirection,
  sortQuality,
} from "./executor-model.js"

export interface QualityTableProps {
  readonly rows: ReadonlyArray<QualityRow>
}

// The 30-day quality of one executor by task kind. Each header sorts; a second press on the same header reverses it.
export function QualityTable({ rows }: QualityTableProps) {
  const [key, setKey] = useState<QualityKey>("n")
  const [direction, setDirection] = useState<SortDirection>("desc")

  if (rows.length === 0) {
    return <Text variant="bodySmall">Sem execuções nos últimos 30 dias</Text>
  }

  const press = (next: QualityKey) => {
    if (next === key) {
      setDirection((current) => (current === "asc" ? "desc" : "asc"))
      return
    }
    setKey(next)
    setDirection("desc")
  }

  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
        {QUALITY_HEADERS.map((header) => (
          <Button key={header.key} compact mode="text" onPress={() => press(header.key)}>
            {header.key === key ? `${header.label} ${direction === "asc" ? "↑" : "↓"}` : header.label}
          </Button>
        ))}
      </View>
      {sortQuality(rows, key, direction).map((row) => (
        <Text key={row.kind} variant="bodySmall">
          {`${row.kind} · sucesso ${formatPct(row.okRate * 100)} · ${row.n} execuções · ${formatUsd(row.avgUsd)} por execução`}
        </Text>
      ))}
    </View>
  )
}
