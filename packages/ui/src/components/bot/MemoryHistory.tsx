import type { MemoryVersion } from "@shoalwork/api-client"
import { useState } from "react"
import { View } from "react-native"
import { Button, HelperText, Text } from "react-native-paper"
import type { MemoryHistoryLoad } from "../../hooks/useBotMemory.js"
import { type MessageKey, useLocale } from "../../i18n/index.js"

export interface MemoryHistoryProps {
  readonly memoryId: string
  readonly load: (memoryId: string) => Promise<MemoryHistoryLoad>
}

type HistoryView =
  | { readonly kind: "closed" }
  | { readonly kind: "loading" }
  | { readonly kind: "shown"; readonly items: ReadonlyArray<MemoryVersion> }
  | { readonly kind: "failed"; readonly status: number }

const stateOf = (version: MemoryVersion): MessageKey => {
  if (version.forgotten) return "memory.state.forgotten"
  return version.supersededBy === null ? "memory.state.current" : "memory.state.superseded"
}

// The versions of one memory item, oldest first. Each content is shown as plain text: it is data, never markup.
export function MemoryHistory({ memoryId, load }: MemoryHistoryProps) {
  const { t } = useLocale()
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
        {view.kind === "closed" ? t("memory.history") : t("memory.hideHistory")}
      </Button>
      {view.kind === "loading" ? <Text variant="bodySmall">{t("memory.loadingHistory")}</Text> : null}
      {view.kind === "failed" ? (
        <HelperText type="error">{t("memory.historyFailed", { status: view.status })}</HelperText>
      ) : null}
      {view.kind === "shown"
        ? view.items.map((version, index) => (
            <View key={version.id} style={{ gap: 2 }}>
              <Text variant="labelSmall">{`${index + 1}. ${t(stateOf(version))} · ${version.createdAt}`}</Text>
              <Text variant="bodySmall">{version.content}</Text>
            </View>
          ))
        : null}
    </View>
  )
}
