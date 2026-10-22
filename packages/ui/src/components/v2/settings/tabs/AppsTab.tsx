import { Text, View } from "react-native"
import { useConnectors } from "../../../../hooks/useCurrents.js"
import { type MessageKey, useLocale } from "../../../../i18n/index.js"
import { tokens } from "../../../../theme.js"
import type { ConnectorEntry } from "../../../currents/currents-model.js"
import { ErrorBanner } from "../../../ErrorBanner.js"
import { Chip } from "../../Chip.js"
import { Icon, type IconName } from "../../Icon.js"
import { ConnectionStatus } from "../ConnectionStatus.js"
import { SectionHeading } from "./ExecutorsTab.js"

const RISK_LABEL: Readonly<Record<string, MessageKey>> = {
  read: "settings.apps.risk.read",
  write_local: "settings.apps.risk.write",
  external: "settings.apps.risk.external",
  irreversible: "settings.apps.risk.irreversible",
}

const RISK_ORDER: ReadonlyArray<string> = ["read", "write_local", "external", "irreversible"]

const iconOf = (entry: ConnectorEntry): IconName => {
  if (entry.id.includes("github")) return "github"
  if (entry.id.includes("notion")) return "book"
  if (entry.kind === "browser") return "globe"
  return "plug"
}

// One connector: tile, name and state, what it may do (the risks of its tools), and the Bots that use it.
export function AppRow({ entry }: { readonly entry: ConnectorEntry }) {
  const { t } = useLocale()
  const risks = RISK_ORDER.filter((risk) => entry.permissions.some((permission) => permission.risk === risk))
  return (
    <View
      accessibilityLabel={entry.name}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 14,
        flexWrap: "wrap",
        padding: 14,
        borderBottomWidth: 1,
        borderBottomColor: tokens.color.border,
      }}
    >
      <View
        style={{
          width: 48,
          height: 48,
          borderRadius: 11,
          borderWidth: 1,
          borderColor: tokens.color.border,
          backgroundColor: "#0D1322",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon name={iconOf(entry)} size={24} color={tokens.color.text} />
      </View>
      <View style={{ flex: 1, minWidth: 180, gap: 4 }}>
        <Text style={{ color: tokens.color.text, fontSize: 18, fontWeight: "600" }}>{entry.name}</Text>
        <ConnectionStatus connected={entry.status === "enabled"} />
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, flex: 1, minWidth: 200 }}>
        {risks.map((risk) => (
          <Chip key={risk} label={t(RISK_LABEL[risk] ?? "settings.apps.risk.read")} />
        ))}
      </View>
      <Text numberOfLines={2} style={{ width: 200, color: tokens.color.textSecondary, fontSize: 14 }}>
        {entry.bots.length === 0
          ? t("settings.apps.noBots")
          : t("settings.apps.usedBy", { bots: entry.bots.map((bot) => bot.name).join(", ") })}
      </Text>
    </View>
  )
}

// `Apps Conectadas`: the native connectors and MCP servers of the core (GET /connectors).
export function AppsTab() {
  const { t } = useLocale()
  const { load, reload } = useConnectors()
  return (
    <View>
      <SectionHeading title={t("settings.apps.title")} subtitle={t("settings.apps.subtitle")} />
      {load.kind === "loading" ? (
        <Text style={{ color: tokens.color.textSecondary }}>{t("common.loading")}</Text>
      ) : null}
      {load.kind === "failed" ? (
        <ErrorBanner
          message={
            load.status === 0 ? t("common.cannotReach") : t("common.httpAnswered", { status: load.status })
          }
          onRetry={reload}
        />
      ) : null}
      {load.kind === "loaded" && load.rows.length === 0 ? (
        <Text style={{ color: tokens.color.textSecondary }}>{t("settings.apps.empty")}</Text>
      ) : null}
      {load.kind === "loaded" && load.rows.length > 0 ? (
        <View
          style={{
            borderRadius: tokens.radius.card,
            borderWidth: 1,
            borderColor: tokens.color.border,
            backgroundColor: tokens.color.surface,
          }}
        >
          {load.rows.map((entry) => (
            <AppRow key={entry.id} entry={entry} />
          ))}
        </View>
      ) : null}
    </View>
  )
}
