import { View } from "react-native"
import { Button, TextInput } from "react-native-paper"
import type { EventFilters as Filters } from "./beacon-model.js"

export interface EventFiltersProps {
  readonly draft: Filters
  readonly onChange: (next: Filters) => void
  readonly onApply: () => void
}

// The filters are applied on "Buscar", not per keystroke: each apply is one request to the core.
export function EventFilters({ draft, onChange, onApply }: EventFiltersProps) {
  return (
    <View style={{ gap: 8 }}>
      <TextInput
        mode="outlined"
        label="Tipos (vírgula)"
        accessibilityLabel="Tipos de evento"
        value={draft.types}
        onChangeText={(types) => onChange({ ...draft, types })}
      />
      <TextInput
        mode="outlined"
        label="Stream"
        accessibilityLabel="Stream"
        value={draft.stream}
        onChangeText={(stream) => onChange({ ...draft, stream })}
      />
      <TextInput
        mode="outlined"
        label="Actor"
        accessibilityLabel="Actor"
        value={draft.actor}
        onChangeText={(actor) => onChange({ ...draft, actor })}
      />
      <TextInput
        mode="outlined"
        label="Busca no payload"
        accessibilityLabel="Busca no log"
        value={draft.q}
        maxLength={200}
        onChangeText={(q) => onChange({ ...draft, q })}
      />
      <Button mode="contained" onPress={onApply}>
        Buscar
      </Button>
    </View>
  )
}
