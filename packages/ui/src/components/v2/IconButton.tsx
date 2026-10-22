import { Pressable } from "react-native"
import { tokens } from "../../theme.js"
import { Icon, type IconName } from "./Icon.js"

export interface IconButtonProps {
  readonly icon: IconName
  // Required: an icon alone says nothing to a screen reader.
  readonly label: string
  readonly onPress?: () => void
  readonly disabled?: boolean
  readonly round?: boolean
  readonly size?: number
  readonly color?: string
  readonly background?: string
}

export function IconButton({
  icon,
  label,
  onPress,
  disabled = false,
  round = false,
  size = 40,
  color = tokens.color.text,
  background = "transparent",
}: IconButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: round ? size / 2 : tokens.radius.button,
        backgroundColor: pressed ? tokens.color.elevated : background,
        opacity: disabled ? 0.4 : 1,
      })}
    >
      <Icon name={icon} color={color} size={Math.round(size * 0.5)} />
    </Pressable>
  )
}
