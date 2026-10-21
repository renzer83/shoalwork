import type { Event } from "@shoalwork/contracts"
import { Pressable, View } from "react-native"
import { Text, useTheme } from "react-native-paper"
import { useLocale } from "../../i18n/index.js"
import { formatInstant } from "./beacon-model.js"

export interface EventTableProps {
  readonly events: ReadonlyArray<Event>
  readonly selectedId: string | null
  readonly onSelect: (event: Event) => void
}

// One row per event, newest first. The payload is not shown here: EventDetail prints it for the selected row.
export function EventTable({ events, selectedId, onSelect }: EventTableProps) {
  const theme = useTheme()
  const { t } = useLocale()
  if (events.length === 0) {
    return <Text variant="bodySmall">{t("beacon.events.none")}</Text>
  }
  return (
    <View style={{ gap: 4 }}>
      {events.map((event) => {
        const selected = event.id === selectedId
        return (
          <Pressable
            key={event.id}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            onPress={() => onSelect(event)}
            style={{
              padding: 8,
              borderRadius: 6,
              borderWidth: 1,
              borderColor: selected ? theme.colors.primary : theme.colors.outlineVariant,
              gap: 2,
            }}
          >
            <Text variant="labelLarge">{event.type}</Text>
            <Text variant="bodySmall">{`#${event.position} · ${formatInstant(event.occurredAt)} · ${event.actor}`}</Text>
            <Text variant="bodySmall">{event.streamId}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}
