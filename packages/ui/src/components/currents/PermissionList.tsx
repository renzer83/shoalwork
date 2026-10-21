import type { Risk } from "@shoalwork/contracts"
import { View } from "react-native"
import { type MD3Theme, Text, useTheme } from "react-native-paper"

export interface PermissionListProps {
  readonly permissions: ReadonlyArray<{ readonly tool: string; readonly risk: Risk }>
}

// One colour per risk, from the theme: reads stay neutral, anything that can change the world is warmer.
export const riskColor = (theme: MD3Theme, risk: Risk): string => {
  switch (risk) {
    case "read":
      return theme.colors.surfaceVariant
    case "write_local":
      return theme.colors.secondaryContainer
    case "external":
      return theme.colors.tertiaryContainer
    case "irreversible":
      return theme.colors.errorContainer
  }
}

// The declared permissions of a connector as chips: the tool, then its risk.
export function PermissionList({ permissions }: PermissionListProps) {
  const theme = useTheme()
  if (permissions.length === 0) {
    return <Text variant="bodySmall">No permissions declared</Text>
  }
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {permissions.map((permission) => (
        <View
          key={`${permission.tool}:${permission.risk}`}
          accessibilityLabel={`${permission.tool} ${permission.risk}`}
          style={{
            flexDirection: "row",
            gap: 6,
            borderRadius: 8,
            paddingHorizontal: 8,
            paddingVertical: 2,
            backgroundColor: riskColor(theme, permission.risk),
          }}
        >
          <Text variant="labelSmall">{permission.tool}</Text>
          <Text variant="labelSmall">{permission.risk}</Text>
        </View>
      ))}
    </View>
  )
}
