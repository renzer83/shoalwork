import { Text, View } from "react-native"
import { useLocale } from "../../../i18n/index.js"
import { tokens } from "../../../theme.js"

// "● Conectado" in green, "○ Desconectado" as a grey ring.
export function ConnectionStatus({
  connected,
  size = 14,
}: {
  readonly connected: boolean
  readonly size?: number
}) {
  const { t } = useLocale()
  const color = connected ? tokens.color.green : tokens.color.textSecondary
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <View
        style={{
          width: 10,
          height: 10,
          borderRadius: 5,
          borderWidth: connected ? 0 : 2,
          borderColor: color,
          backgroundColor: connected ? color : "transparent",
        }}
      />
      <Text style={{ color, fontSize: size }}>
        {connected ? t("settings.status.connected") : t("settings.status.disconnected")}
      </Text>
    </View>
  )
}
