import { Text, View } from "react-native"
import { type MessageKey, useLocale } from "../../../../i18n/index.js"
import { tokens } from "../../../../theme.js"
import { Card } from "../../Card.js"
import { Icon, type IconName } from "../../Icon.js"
import { SectionHeading } from "./ExecutorsTab.js"

interface Effect {
  readonly title: MessageKey
  readonly text: MessageKey
  readonly color: string
  readonly icon: IconName
}

const EFFECTS: ReadonlyArray<Effect> = [
  {
    title: "settings.policies.allow",
    text: "settings.policies.allowText",
    color: tokens.color.green,
    icon: "check",
  },
  {
    title: "settings.policies.ask",
    text: "settings.policies.askText",
    color: tokens.color.amber,
    icon: "shield",
  },
  {
    title: "settings.policies.deny",
    text: "settings.policies.denyText",
    color: tokens.color.red,
    icon: "close",
  },
]

// `Políticas`: how a Bot's tool call is decided, as the policy engine applies it. Read-only: the rules live in
// config/policies/*.yaml and the core has no route to list or edit them yet.
export function PoliciesTab() {
  const { t } = useLocale()
  return (
    <View style={{ gap: 14 }}>
      <SectionHeading title={t("settings.policies.title")} subtitle={t("settings.policies.subtitle")} />
      {EFFECTS.map((effect) => (
        <Card key={effect.title} style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
          <Icon name={effect.icon} size={22} color={effect.color} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ color: effect.color, fontSize: 16, fontWeight: "700" }}>{t(effect.title)}</Text>
            <Text style={{ color: tokens.color.textSecondary, fontSize: 14 }}>{t(effect.text)}</Text>
          </View>
        </Card>
      ))}
      <Text style={{ color: tokens.color.textSecondary, fontSize: 14 }}>
        {t("settings.policies.readOnly")}
      </Text>
    </View>
  )
}
