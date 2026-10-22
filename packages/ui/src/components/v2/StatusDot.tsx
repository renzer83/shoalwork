import type { BotState } from "@shoalwork/contracts"
import { Text, View } from "react-native"
import { tokens } from "../../theme.js"

// Colour of a Bot state: working or idle reads as online, a wait as attention, a block as error, the rest as off.
export const stateColor = (state: BotState): string => {
  switch (state) {
    case "idle":
    case "done":
    case "thinking":
    case "working":
      return tokens.color.green
    case "waiting_approval":
      return tokens.color.amber
    case "blocked":
      return tokens.color.red
    case "paused":
    case "archived":
      return tokens.color.textSecondary
  }
}

export interface StatusDotProps {
  readonly color: string
  readonly size?: number
}

export function StatusDot({ color, size = 10 }: StatusDotProps) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />
}

export interface StatusLabelProps {
  readonly color: string
  readonly label: string
  readonly size?: number
}

// "● Online"
export function StatusLabel({ color, label, size = 14 }: StatusLabelProps) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <StatusDot color={color} />
      <Text style={{ color, fontSize: size }}>{label}</Text>
    </View>
  )
}
