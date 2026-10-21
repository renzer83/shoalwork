import { View } from "react-native"
import { Button } from "react-native-paper"
import { PERIODS, type PeriodKey } from "./beacon-model.js"

export interface PeriodPickerProps {
  readonly value: PeriodKey
  readonly onChange: (period: PeriodKey) => void
}

export function PeriodPicker({ value, onChange }: PeriodPickerProps) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {PERIODS.map((period) => (
        <Button
          key={period.key}
          mode={period.key === value ? "contained" : "outlined"}
          onPress={() => onChange(period.key)}
          accessibilityLabel={`Período ${period.label}`}
        >
          {period.label}
        </Button>
      ))}
    </View>
  )
}
