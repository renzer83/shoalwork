import { View } from "react-native"
import { Text } from "react-native-paper"

export function EmptyState({ title, hint }: { readonly title: string; readonly hint?: string }) {
  return (
    <View style={{ alignItems: "center", padding: 24, gap: 8 }}>
      <Text variant="titleMedium">{title}</Text>
      {hint === undefined ? null : <Text variant="bodyMedium">{hint}</Text>}
    </View>
  )
}
