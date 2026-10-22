import { Pressable, Text, View } from "react-native"
import { tokens } from "../../../theme.js"
import { Icon } from "../Icon.js"
import type { ModelInfo } from "./executor-catalog.js"

export interface ModelChipsProps {
  readonly models: ReadonlyArray<ModelInfo>
  // The main model: drawn with the blue border and the mark.
  readonly main: string | undefined
  readonly onSelect: (model: string) => void
  readonly disabled?: boolean
}

// The models of one executor as a row of chips. Pressing one makes it the main model.
export function ModelChips({ models, main, onSelect, disabled = false }: ModelChipsProps) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
      {models.map((model) => {
        const selected = model.id === main
        return (
          <Pressable
            key={model.id}
            accessibilityRole="button"
            accessibilityLabel={model.label}
            accessibilityState={{ selected, disabled }}
            disabled={disabled}
            onPress={() => onSelect(model.id)}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              minHeight: 34,
              paddingHorizontal: 14,
              borderRadius: tokens.radius.button,
              borderWidth: 1,
              borderColor: selected ? tokens.color.accent : tokens.color.border,
              backgroundColor: selected
                ? tokens.color.accentSoft
                : pressed
                  ? tokens.color.elevated
                  : tokens.color.surface,
              opacity: disabled ? 0.55 : 1,
            })}
          >
            {selected ? <Icon name="sparkle" size={14} color={tokens.color.link} /> : null}
            <Text style={{ color: tokens.color.text, fontSize: 14 }}>{model.label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}
