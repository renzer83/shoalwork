import { Pressable, View } from "react-native"
import { Card, Text, useTheme } from "react-native-paper"
import type { ConnectorEntry } from "./currents-model.js"
import { KIND_LABEL } from "./currents-model.js"
import { PermissionList } from "./PermissionList.js"

export interface ConnectorCardProps {
  readonly connector: ConnectorEntry
  readonly onOpen?: (id: string) => void
}

// One connector of the catalog: name, kind, status, how many Bots use it, its last use and its permissions.
export function ConnectorCard({ connector, onOpen }: ConnectorCardProps) {
  const theme = useTheme()
  const used =
    connector.lastUsedAt === null ? "not used in the last 30 days" : `last used ${connector.lastUsedAt}`
  return (
    <Pressable accessibilityRole="button" onPress={() => onOpen?.(connector.id)}>
      <Card>
        <Card.Content style={{ gap: 6 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <Text variant="titleMedium">{connector.name}</Text>
            <Text variant="labelLarge">{connector.status}</Text>
          </View>
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
            {`${KIND_LABEL[connector.kind]} · ${connector.bots.length} bot(s)`}
          </Text>
          <Text variant="bodySmall">{used}</Text>
          <PermissionList permissions={connector.permissions} />
        </Card.Content>
      </Card>
    </Pressable>
  )
}
