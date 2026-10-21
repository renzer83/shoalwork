import type { MemoryHit } from "@shoalwork/api-client"
import { useState } from "react"
import { View } from "react-native"
import { Button, Card, Text, TextInput } from "react-native-paper"
import type { MemoryLoad } from "../../hooks/useBotMemory.js"
import { EmptyState } from "../EmptyState.js"
import { ErrorBanner } from "../ErrorBanner.js"

export interface MemoryListProps {
  readonly load: MemoryLoad
  readonly onSearch: (text: string) => void
  readonly onForget: (memoryId: string) => void
}

const hitsOf = (load: MemoryLoad): ReadonlyArray<MemoryHit> => (load.kind === "loaded" ? load.hits : [])

// The Bot's memory: the current items, or the hits of a search. Edit is not here yet (the list only forgets).
export function MemoryList({ load, onSearch, onForget }: MemoryListProps) {
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
        <Card key={hit.id}>
          <Card.Content style={{ gap: 4 }}>
            <Text variant="labelMedium">
              {hit.score === undefined ? hit.kind : `${hit.kind} · score ${hit.score.toFixed(2)}`}
            </Text>
            <Text variant="bodyMedium">{hit.content}</Text>
            <Button compact onPress={() => onForget(hit.id)}>
              Forget
            </Button>
          </Card.Content>
        </Card>
      ))}
    </View>
  )
}
