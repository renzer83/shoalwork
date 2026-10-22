import { Text, View } from "react-native"
import { tokens } from "../../../theme.js"
import { Avatar } from "../Avatar.js"
import { Card } from "../Card.js"
import { StatusLabel } from "../StatusDot.js"

export interface BotCardProps {
  readonly botId: string
  readonly name: string
  readonly status: { readonly color: string; readonly label: string }
}

export function BotCard({ botId, name, status }: BotCardProps) {
  return (
    <Card style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
      <Avatar id={botId} size={52} />
      <View style={{ flex: 1, gap: 4 }}>
        <Text numberOfLines={1} style={{ color: tokens.color.text, fontSize: 17, fontWeight: "700" }}>
          {name}
        </Text>
        <StatusLabel color={status.color} label={status.label} />
      </View>
    </Card>
  )
}
