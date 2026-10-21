import type { MemoryHit } from "@shoalwork/api-client"
import { useState } from "react"
import { View } from "react-native"
import { Button, Text, TextInput } from "react-native-paper"
import type { MemoryEdit, MemoryHistoryLoad, MemoryLoad } from "../../hooks/useBotMemory.js"
import { EmptyState } from "../EmptyState.js"
import { ErrorBanner } from "../ErrorBanner.js"
import { MemoryItem } from "./MemoryItem.js"

export interface MemoryListProps {
  readonly load: MemoryLoad
  readonly onSearch: (text: string) => void
  readonly onForget: (memoryId: string) => void
  readonly onEdit: (memoryId: string, content: string) => Promise<MemoryEdit>
  readonly onHistory: (memoryId: string) => Promise<MemoryHistoryLoad>
}

const hitsOf = (load: MemoryLoad): ReadonlyArray<MemoryHit> => (load.kind === "loaded" ? load.hits : [])

// The Bot's memory: the current items, or the hits of a search. Each item can be edited or forgotten.
export function MemoryList({ load, onSearch, onForget, onEdit, onHistory }: MemoryListProps) {
  const [text, setText] = useState("")
  const hits = hitsOf(load)
  return (
    <View style={{ gap: 8 }}>
      <TextInput
        label="Search memory (empty shows the latest)"
        value={text}
        onChangeText={setText}
        autoCapitalize="none"
      />
      <Button mode="outlined" onPress={() => onSearch(text)}>
        Search
      </Button>
      {load.kind === "searching" ? <Text variant="bodySmall">Loading…</Text> : null}
      {load.kind === "failed" ? (
        <ErrorBanner message={`Memory request failed (HTTP ${load.status})`} />
      ) : null}
      {load.kind === "loaded" && hits.length === 0 ? <EmptyState title="No memory to show" /> : null}
      {hits.map((hit) => (
        <MemoryItem key={hit.id} hit={hit} onEdit={onEdit} onForget={onForget} onHistory={onHistory} />
      ))}
    </View>
  )
}
