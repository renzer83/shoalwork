import { type ReactNode, useState } from "react"
import { Pressable, Text, View } from "react-native"
import type { ExecutorsState } from "../../../../hooks/useExecutors.js"
import { useLocale } from "../../../../i18n/index.js"
import { tokens } from "../../../../theme.js"
import { ErrorBanner } from "../../../ErrorBanner.js"
import { Icon } from "../../Icon.js"
import { ExecutorRow } from "../ExecutorRow.js"
import { RoutingList } from "../RoutingList.js"
import type { ExecutorSetting, RouteEntry } from "../settings-model.js"

export interface ExecutorsTabProps {
  readonly load: ExecutorsState["load"]
  readonly onReload: () => void
  readonly probeFailure: string | null
  readonly settings: ReadonlyArray<ExecutorSetting>
  readonly selectedId: string | undefined
  readonly routing: ReadonlyArray<RouteEntry>
  readonly onRouting: (entries: ReadonlyArray<RouteEntry>) => void
  readonly onSelect: (id: string) => void
  readonly onToggle: (id: string, enabled: boolean) => void
  readonly onPriority: (id: string, priority: number) => void
  readonly onModel: (id: string, model: string) => void
  // The detail of the selected executor, when the right column has no room for it.
  readonly inlineDetail?: ReactNode
}

export const SectionHeading = ({
  title,
  subtitle,
}: {
  readonly title: string
  readonly subtitle: string
}) => (
  <View style={{ gap: 4, marginBottom: 10 }}>
    <Text accessibilityRole="header" style={{ color: tokens.color.text, fontSize: 19, fontWeight: "700" }}>
      {title}
    </Text>
    <Text style={{ color: tokens.color.textSecondary, fontSize: 14 }}>{subtitle}</Text>
  </View>
)

// `Executores de IA` (the list with models, priority and switches) and, under it, `Ordem de resposta do Guia`.
export function ExecutorsTab({
  load,
  onReload,
  probeFailure,
  settings,
  selectedId,
  routing,
  onRouting,
  onSelect,
  onToggle,
  onPriority,
  onModel,
  inlineDetail,
}: ExecutorsTabProps) {
  const { t } = useLocale()
  const [adding, setAdding] = useState(false)
  return (
    <View style={{ gap: 28 }}>
      <View>
        <SectionHeading title={t("settings.executors.title")} subtitle={t("settings.executors.subtitle")} />
        {load.kind === "loading" ? (
          <Text style={{ color: tokens.color.textSecondary }}>{t("executors.loading")}</Text>
        ) : null}
        {load.kind === "failed" ? <ErrorBanner message={load.message} onRetry={onReload} /> : null}
        {probeFailure === null ? null : <ErrorBanner message={probeFailure} />}
        {load.kind === "loaded" && settings.length === 0 ? (
          <Text style={{ color: tokens.color.textSecondary }}>{t("executors.empty")}</Text>
        ) : null}
        {settings.length > 0 ? (
          <View
            style={{
              borderRadius: tokens.radius.card,
              borderWidth: 1,
              borderColor: tokens.color.border,
              backgroundColor: tokens.color.surface,
            }}
          >
            {settings.map((setting) => (
              <ExecutorRow
                key={setting.id}
                setting={setting}
                count={settings.length}
                selected={setting.id === selectedId}
                onSelect={onSelect}
                onToggle={onToggle}
                onPriority={onPriority}
                onModel={onModel}
              />
            ))}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("settings.executors.add")}
              accessibilityState={{ expanded: adding }}
              onPress={() => setAdding((was) => !was)}
              style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 16 }}
            >
              <Icon name="plus" size={20} color={tokens.color.text} />
              <Text style={{ color: tokens.color.text, fontSize: 16 }}>{t("settings.executors.add")}</Text>
            </Pressable>
            {adding ? (
              <Text style={{ color: tokens.color.textSecondary, fontSize: 14, padding: 16, paddingTop: 0 }}>
                {t("settings.executors.addHint")}
              </Text>
            ) : null}
          </View>
        ) : null}
        {inlineDetail === undefined ? null : <View style={{ marginTop: 14 }}>{inlineDetail}</View>}
      </View>
      <View>
        <SectionHeading title={t("settings.routing.title")} subtitle={t("settings.routing.subtitle")} />
        <RoutingList entries={routing} onChange={onRouting} />
      </View>
    </View>
  )
}
