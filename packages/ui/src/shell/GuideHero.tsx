import { Pressable, Text, View } from "react-native"
import { GuideAvatar } from "../components/v2/Avatar.js"
import { StatusLabel } from "../components/v2/StatusDot.js"
import { useLocale } from "../i18n/index.js"
import { tokens } from "../theme.js"

export interface GuideHeroProps {
  readonly status: { readonly color: string; readonly label: string }
  readonly onPress: () => void
}

// The 3D Guide with its glow, name and live status. It is the Lead: pressing it opens that chat.
export function GuideHero({ status, onPress }: GuideHeroProps) {
  const { t } = useLocale()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("shell.openGuide")}
      onPress={onPress}
      style={{ alignItems: "center", gap: 6, paddingTop: 6, paddingBottom: 14 }}
    >
      <View style={{ width: 120, height: 120, alignItems: "center", justifyContent: "center" }}>
        <View
          style={{
            position: "absolute",
            width: 90,
            height: 90,
            borderRadius: 45,
            boxShadow: `0 0 56px 14px ${tokens.color.accentGlow}`,
          }}
        />
        <GuideAvatar size={120} />
      </View>
      <Text style={{ color: tokens.color.text, fontSize: 19, fontWeight: "700" }}>{t("shell.guide")}</Text>
      <StatusLabel color={status.color} label={status.label} />
    </Pressable>
  )
}
