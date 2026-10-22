import type { ReactNode } from "react"
import { Text, View } from "react-native"
import { useLocale } from "../../../i18n/index.js"
import { tokens } from "../../../theme.js"
import { Card } from "../Card.js"
import { Icon, type IconName } from "../Icon.js"

export interface AboutBotProps {
  readonly description: string
  readonly project: string | undefined
  readonly executor: string
  readonly model: string | undefined
  readonly fallback: string | undefined
}

const DASH = "—"

function Pair({
  icon,
  label,
  value,
}: {
  readonly icon: IconName
  readonly label: string
  readonly value: string
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10 }}>
      <Icon name={icon} size={18} color={tokens.color.textSecondary} />
      <Text style={{ flex: 1, color: tokens.color.textSecondary, fontSize: 14 }}>{label}</Text>
      <Text numberOfLines={1} style={{ flex: 1, color: tokens.color.text, fontSize: 14 }}>
        {value}
      </Text>
    </View>
  )
}

export const PanelSection = ({
  title,
  children,
}: {
  readonly title: string
  readonly children: ReactNode
}) => (
  <Card style={{ gap: 6 }}>
    <Text style={{ color: tokens.color.text, fontSize: 16, fontWeight: "700", marginBottom: 4 }}>
      {title}
    </Text>
    {children}
  </Card>
)

export function AboutBot({ description, project, executor, model, fallback }: AboutBotProps) {
  const { t } = useLocale()
  return (
    <PanelSection title={t("conv.about.title")}>
      <Text style={{ color: tokens.color.textSecondary, fontSize: 15, lineHeight: 22 }}>{description}</Text>
      <View style={{ borderTopWidth: 1, borderTopColor: tokens.color.border, marginTop: 8 }}>
        <Pair icon="folder" label={t("conv.about.project")} value={project ?? DASH} />
        <Pair icon="terminal" label={t("conv.about.executor")} value={executor} />
        <Pair icon="sparkle" label={t("conv.about.model")} value={model ?? DASH} />
        <Pair icon="shield" label={t("conv.about.fallback")} value={fallback ?? DASH} />
      </View>
    </PanelSection>
  )
}
