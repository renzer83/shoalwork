import { View } from "react-native"
import { Button, TextInput } from "react-native-paper"
import { useLocale } from "../../i18n/index.js"
import type { EventFilters as Filters } from "./beacon-model.js"

export interface EventFiltersProps {
  readonly draft: Filters
  readonly onChange: (next: Filters) => void
  readonly onApply: () => void
}

// The filters are applied on "Buscar", not per keystroke: each apply is one request to the core.
export function EventFilters({ draft, onChange, onApply }: EventFiltersProps) {
  const { t } = useLocale()
  return (
    <View style={{ gap: 8 }}>
      <TextInput
        mode="outlined"
        label={t("beacon.filter.types")}
        accessibilityLabel={t("beacon.filter.typesA11y")}
        value={draft.types}
        onChangeText={(types) => onChange({ ...draft, types })}
      />
      <TextInput
        mode="outlined"
        label={t("beacon.filter.stream")}
        accessibilityLabel={t("beacon.filter.stream")}
        value={draft.stream}
        onChangeText={(stream) => onChange({ ...draft, stream })}
      />
      <TextInput
        mode="outlined"
        label={t("beacon.filter.actor")}
        accessibilityLabel={t("beacon.filter.actor")}
        value={draft.actor}
        onChangeText={(actor) => onChange({ ...draft, actor })}
      />
      <TextInput
        mode="outlined"
        label={t("beacon.filter.payload")}
        accessibilityLabel={t("beacon.filter.logA11y")}
        value={draft.q}
        maxLength={200}
        onChangeText={(q) => onChange({ ...draft, q })}
      />
      <Button mode="contained" onPress={onApply}>
        {t("beacon.filter.search")}
      </Button>
    </View>
  )
}
