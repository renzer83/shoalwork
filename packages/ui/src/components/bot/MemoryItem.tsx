import type { MemoryHit } from "@shoalwork/api-client"
import { useState } from "react"
import { View } from "react-native"
import { Button, Card, HelperText, Text, TextInput } from "react-native-paper"
import type { MemoryEdit, MemoryHistoryLoad } from "../../hooks/useBotMemory.js"
import { MemoryHistory } from "./MemoryHistory.js"

export interface MemoryItemProps {
  readonly hit: MemoryHit
  readonly onEdit: (memoryId: string, content: string) => Promise<MemoryEdit>
  readonly onForget: (memoryId: string) => void
  readonly onHistory: (memoryId: string) => Promise<MemoryHistoryLoad>
}

// One memory item. Edit opens an inline field; a saved edit closes it, and the list is read again by the caller.
export function MemoryItem({ hit, onEdit, onForget, onHistory }: MemoryItemProps) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(hit.content)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const open = () => {
    setText(hit.content)
    setError(null)
    setEditing(true)
  }

  const cancel = () => {
    setError(null)
    setEditing(false)
  }

  const save = () => {
    const content = text.trim()
    if (content === "") {
      setError("Memory cannot be empty")
      return
    }
    if (content === hit.content) {
      cancel()
      return
    }
    setError(null)
    setSaving(true)
    void onEdit(hit.id, content).then((outcome) => {
      setSaving(false)
      if (outcome.ok) {
        setEditing(false)
      } else {
        setError(`Could not save (HTTP ${outcome.status})`)
      }
    })
  }

  return (
    <Card>
      <Card.Content style={{ gap: 4 }}>
        <Text variant="labelMedium">
          {hit.score === undefined ? hit.kind : `${hit.kind} · score ${hit.score.toFixed(2)}`}
        </Text>
        {editing ? (
          <View style={{ gap: 6 }}>
            <TextInput
              mode="outlined"
              multiline
              value={text}
              onChangeText={setText}
              accessibilityLabel="Memory text"
              placeholder="Memory text"
              disabled={saving}
            />
            {error === null ? null : <HelperText type="error">{error}</HelperText>}
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Button mode="contained" onPress={save} disabled={saving}>
                Save memory
              </Button>
              <Button onPress={cancel} disabled={saving}>
                Cancel
              </Button>
            </View>
          </View>
        ) : (
          <>
            <Text variant="bodyMedium">{hit.content}</Text>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Button compact onPress={open}>
                Edit
              </Button>
              <Button compact onPress={() => onForget(hit.id)}>
                Forget
              </Button>
            </View>
            <MemoryHistory memoryId={hit.id} load={onHistory} />
          </>
        )}
      </Card.Content>
    </Card>
  )
}
