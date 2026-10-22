import { Pressable, View } from "react-native"
import { tokens } from "../../../theme.js"

export interface ToggleProps {
  readonly value: boolean
  readonly onChange: (value: boolean) => void
  // Required: the switch has no text of its own.
  readonly label: string
  readonly disabled?: boolean
}

const WIDTH = 52
const HEIGHT = 30
const THUMB = 24

// The blue switch of the reference: on is the accent colour with the thumb on the right.
export function Toggle({ value, onChange, label, disabled = false }: ToggleProps) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={() => onChange(!value)}
      style={{ opacity: disabled ? 0.45 : 1 }}
    >
      <View
        style={{
          width: WIDTH,
          height: HEIGHT,
          borderRadius: HEIGHT / 2,
          justifyContent: "center",
          backgroundColor: value ? tokens.color.accent : tokens.color.elevated,
          borderWidth: 1,
          borderColor: value ? tokens.color.accent : tokens.color.border,
        }}
      >
        <View
          style={{
            position: "absolute",
            top: (HEIGHT - THUMB) / 2 - 1,
            left: value ? WIDTH - THUMB - 4 : 3,
            width: THUMB,
            height: THUMB,
            borderRadius: THUMB / 2,
            backgroundColor: tokens.color.white,
          }}
        />
      </View>
    </Pressable>
  )
}
