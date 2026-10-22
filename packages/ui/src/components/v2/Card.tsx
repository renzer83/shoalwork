import type { ReactNode } from "react"
import { View, type ViewStyle } from "react-native"
import { tokens } from "../../theme.js"

export interface CardProps {
  readonly children: ReactNode
  readonly accessibilityLabel?: string
  readonly borderColor?: string
  readonly background?: string
  readonly style?: ViewStyle
}

export function Card({
  children,
  accessibilityLabel,
  borderColor = tokens.color.border,
  background = tokens.color.surface,
  style,
}: CardProps) {
  return (
    <View
      accessibilityLabel={accessibilityLabel}
      style={[
        {
          backgroundColor: background,
          borderRadius: tokens.radius.card,
          borderWidth: 1,
          borderColor,
          padding: 14,
        },
        style,
      ]}
    >
      {children}
    </View>
  )
}
