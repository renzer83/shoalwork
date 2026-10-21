import type { Event } from "@shoalwork/contracts"
import { View } from "react-native"
import { Button, Text } from "react-native-paper"
import { botIdOf, taskIdOf } from "./beacon-model.js"

export interface EventDetailProps {
  readonly event: Event | null
  readonly onOpenBot?: ((botId: string) => void) | undefined
  // Runs the task of a task stream again as a new one (T-122). Without it there is no Replay button.
  readonly onReplay?: ((taskId: string) => void) | undefined
}

// The payload as JSON text. It is data from the log, shown as plain text and never interpreted.
export function EventDetail({ event, onOpenBot, onReplay }: EventDetailProps) {
  if (event === null) {
    return <Text variant="bodySmall">Selecione um evento para ver o payload.</Text>
  }
  const botId = botIdOf(event.streamId)
  const taskId = taskIdOf(event.streamId)
  return (
    <View style={{ gap: 6 }}>
      <Text variant="titleSmall">{event.type}</Text>
      <Text variant="bodySmall" selectable>{`${event.id} · ${event.actor} · ${event.correlationId}`}</Text>
      {botId !== undefined && onOpenBot !== undefined ? (
        <Button onPress={() => onOpenBot(botId)}>Abrir bot</Button>
      ) : null}
      {taskId !== undefined && onReplay !== undefined ? (
        <Button mode="outlined" onPress={() => onReplay(taskId)}>
          Replay
        </Button>
      ) : null}
      <Text selectable style={{ fontFamily: "monospace" }}>
        {JSON.stringify(event.payload, null, 2)}
      </Text>
    </View>
  )
}
