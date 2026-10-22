import { useState } from "react"
import { Pressable, Text, View } from "react-native"
import { tokens } from "../../../theme.js"
import { Icon } from "../Icon.js"

export interface DropdownOption<T extends string> {
  readonly value: T
  readonly label: string
}

export interface DropdownProps<T extends string> {
  readonly value: T
  readonly options: ReadonlyArray<DropdownOption<T>>
  readonly onChange: (value: T) => void
  // Names the control for a screen reader: "Prioridade, Prioridade 1".
  readonly label: string
  readonly width?: number
  readonly disabled?: boolean
}

// A closed box with the current choice and a chevron; open, a list of the options right below it.
export function Dropdown<T extends string>({
  value,
  options,
  onChange,
  label,
  width,
  disabled = false,
}: DropdownProps<T>) {
  const [open, setOpen] = useState(false)
  const current = options.find((option) => option.value === value)?.label ?? value
  return (
    <View style={{ width, zIndex: open ? 30 : 0 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${current}`}
        accessibilityState={{ expanded: open, disabled }}
        aria-haspopup="menu"
        disabled={disabled}
        onPress={() => setOpen((was) => !was)}
        onKeyDown={(event) => {
          if (event.nativeEvent.key === "Escape") setOpen(false)
        }}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          minHeight: 40,
          paddingHorizontal: 12,
          borderRadius: tokens.radius.button,
          borderWidth: 1,
          borderColor: open ? tokens.color.accent : tokens.color.border,
          backgroundColor: pressed ? tokens.color.elevated : tokens.color.surface,
          opacity: disabled ? 0.45 : 1,
        })}
      >
        <Text numberOfLines={1} style={{ flex: 1, color: tokens.color.text, fontSize: 14 }}>
          {current}
        </Text>
        <Icon name="chevronDown" size={16} color={tokens.color.textSecondary} />
      </Pressable>
      {open ? (
        <View
          role="menu"
          accessibilityLabel={label}
          style={{
            position: "absolute",
            top: 44,
            left: 0,
            right: 0,
            minWidth: 160,
            paddingVertical: 4,
            borderRadius: tokens.radius.button,
            borderWidth: 1,
            borderColor: tokens.color.border,
            backgroundColor: tokens.color.elevated,
            zIndex: 40,
          }}
        >
          {options.map((option) => (
            <Pressable
              key={option.value}
              role="menuitem"
              accessibilityLabel={option.label}
              accessibilityState={{ selected: option.value === value }}
              onPress={() => {
                setOpen(false)
                if (option.value !== value) onChange(option.value)
              }}
              style={({ pressed }) => ({
                paddingHorizontal: 12,
                paddingVertical: 9,
                backgroundColor:
                  option.value === value
                    ? tokens.color.accentSoft
                    : pressed
                      ? tokens.color.surface
                      : "transparent",
              })}
            >
              <Text
                style={{
                  color: option.value === value ? tokens.color.link : tokens.color.text,
                  fontSize: 14,
                }}
              >
                {option.label}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  )
}
