import type { MemoryVersion } from "@shoalwork/api-client"
import { useState } from "react"
import { View } from "react-native"
import { Button, HelperText, Text } from "react-native-paper"
import type { MemoryHistoryLoad } from "../../hooks/useBotMemory.js"

export interface MemoryHistoryProps {
  readonly memoryId: string
  readonly load: (memoryId: string) => Promise<MemoryHistoryLoad>
}

type HistoryView =
  | { readonly kind: "closed" }
  | { readonly kind: "loading" }
  | { readonly kind: "shown"; readonly items: ReadonlyArray<MemoryVersion> }
  | { readonly kind: "failed"; readonly status: number }

const stateOf = (version: MemoryVersion): string => {
  if (version.forgotten) return "forgotten"
  return version.supersededBy === null ? "current" : "superseded"
}

// The versions of one memory item, oldest first. Each content is shown as plain text: it is data, never markup.
export function MemoryHistory({ memoryId, load }: MemoryHistoryProps) {
  const [view, setView] = useState<HistoryView>({ kind: "closed" })

  const toggle = () => {
    if (view.kind !== "closed") {
      setView({ kind: "closed" })
      return
    }
    setView({ kind: "loading" })
    void load(memoryId).then((outcome) => {
      setView(
        outcome.ok ? { kind: "shown", items: outcome.items } : { kind: "failed", status: outcome.status },
      )
    })
  }

  return (
    <View style={{ gap: 6 }}>
      <Button compact onPress={toggle}>
        {view.kind === "closed" ? "History" : "Hide history"}
      </Button>
      {view.kind === "loading" ? <Text variant="bodySmall">Loading history…</Text> : null}
      {view.kind === "failed" ? (
        <HelperText type="error">{`History failed (HTTP ${view.status})`}</HelperText>
      ) : null}
      {view.kind === "shown"
        ? view.items.map((version, index) => (
            <View key={version.id} style={{ gap: 2 }}>
              <Text variant="labelSmall">{`${index + 1}. ${stateOf(version)} · ${version.createdAt}`}</Text>
              <Text variant="bodySmall">{version.content}</Text>
            </View>
          ))
        : null}
    </View>
  )
}
