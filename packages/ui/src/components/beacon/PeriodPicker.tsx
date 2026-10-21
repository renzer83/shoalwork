import { View } from "react-native"
import { Button } from "react-native-paper"
import { useLocale } from "../../i18n/index.js"
import { PERIODS, type PeriodKey } from "./beacon-model.js"

export interface PeriodPickerProps {
  readonly value: PeriodKey
  readonly onChange: (period: PeriodKey) => void
}

export function PeriodPicker({ value, onChange }: PeriodPickerProps) {
  const { t } = useLocale()
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {PERIODS.map((period) => (
        <Button
          key={period.key}
          mode={period.key === value ? "contained" : "outlined"}
          onPress={() => onChange(period.key)}
          accessibilityLabel={t("beacon.period.a11y", { period: t(period.labelKey) })}
        >
          {t(period.labelKey)}
        </Button>
      ))}
    </View>
  )
}
