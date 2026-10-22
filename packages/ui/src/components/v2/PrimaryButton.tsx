import { type ReactNode, useId } from "react"
import { Pressable, Text } from "react-native"
import { tokens } from "../../theme.js"

export interface PrimaryButtonProps {
  readonly label: string
  readonly onPress?: () => void
  readonly disabled?: boolean
  // `primary` is the filled blue button, `secondary` the dark one.
  readonly variant?: "primary" | "secondary"
  readonly icon?: ReactNode
  // Read out after the label by screen readers.
  readonly hint?: string
}

export function PrimaryButton({
  label,
  onPress,
  disabled = false,
  variant = "primary",
  icon,
  hint,
}: PrimaryButtonProps) {
  const primary = variant === "primary"
  const hintId = useId()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      {...(hint === undefined ? {} : ({ "aria-describedby": hintId } as object))}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        minHeight: 40,
        paddingHorizontal: 18,
        borderRadius: tokens.radius.button,
        backgroundColor: primary ? tokens.color.accent : tokens.color.elevated,
        opacity: disabled ? 0.45 : pressed ? 0.85 : 1,
      })}
    >
      {icon}
      <Text style={{ color: tokens.color.text, fontSize: tokens.font.size, fontWeight: "600" }}>{label}</Text>
      {hint === undefined ? null : (
        <Text nativeID={hintId} style={{ position: "absolute", width: 1, height: 1, opacity: 0 }}>
          {hint}
        </Text>
      )}
    </Pressable>
  )
}
