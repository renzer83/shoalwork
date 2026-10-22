import { type ReactNode, useState } from "react"
import { Pressable, ScrollView, Text, View } from "react-native"
import { type MessageKey, type Translate, useLocale } from "../../../i18n/index.js"
import { tokens } from "../../../theme.js"
import { DOCTOR_LABEL, LOGIN_LABEL } from "../../executor/executor-model.js"
import { Card } from "../Card.js"
import { Icon } from "../Icon.js"
import { IconButton } from "../IconButton.js"
import { PrimaryButton } from "../PrimaryButton.js"
import { ConnectionStatus } from "./ConnectionStatus.js"
import { ExecutorIcon } from "./ExecutorIcon.js"
import { costPer1kOf, familyOf, type ModelTag } from "./executor-catalog.js"
import { Slider } from "./Slider.js"
import {
  type ExecutorSetting,
  MAX_MAX_TOKENS,
  MIN_MAX_TOKENS,
  tokensLabel,
  usdLabel,
} from "./settings-model.js"
import { Tabs } from "./Tabs.js"
import { Toggle } from "./Toggle.js"

type DetailTab = "general" | "models" | "credentials" | "advanced"

export interface ExecutorDetailActions {
  readonly onTest: (id: string) => void
  readonly onEnabled: (id: string, enabled: boolean) => void
  readonly onDefault: (id: string, isDefault: boolean) => void
  readonly onModel: (id: string, model: string) => void
  readonly onMaxTokens: (id: string, tokens: number) => void
}

export interface ExecutorDetailProps {
  readonly setting: ExecutorSetting
  // Width of the column; the panel fills its parent when it is absent (a phone, where it sits under the list).
  readonly width?: number
  readonly probing: boolean
  // When the doctor last ran for it in this session.
  readonly checkedAt: number | undefined
  readonly now: number
  // Bot id -> name, for the logins.
  readonly botNames: Readonly<Record<string, string>>
  readonly actions: ExecutorDetailActions
}

const TAG_LABEL: Readonly<Record<ModelTag, MessageKey>> = {
  default: "settings.tag.default",
  quality: "settings.tag.quality",
  reasoning: "settings.tag.reasoning",
  complex: "settings.tag.complex",
  speed: "settings.tag.speed",
  simple: "settings.tag.simple",
}

const TAG_STYLE: Readonly<Record<ModelTag, { readonly color: string; readonly background: string }>> = {
  default: { color: tokens.color.text, background: tokens.color.purple },
  quality: { color: tokens.color.link, background: tokens.color.accentSoft },
  reasoning: { color: tokens.color.amber, background: "rgba(245, 165, 36, 0.16)" },
  complex: { color: tokens.color.textSecondary, background: tokens.color.elevated },
  speed: { color: tokens.color.amber, background: "rgba(245, 165, 36, 0.16)" },
  simple: { color: tokens.color.textSecondary, background: tokens.color.elevated },
}

// "agora", "há 2 min", "há 3 h".
export const agoLabel = (checkedAt: number | undefined, now: number, t: Translate): string => {
  if (checkedAt === undefined) return "—"
  const minutes = Math.floor(Math.max(0, now - checkedAt) / 60_000)
  if (minutes < 1) return t("settings.detail.ago.now")
  if (minutes < 60) return t("settings.detail.ago.min", { n: minutes })
  return t("settings.detail.ago.hour", { n: Math.floor(minutes / 60) })
}

const SectionTitle = ({ children }: { readonly children: ReactNode }) => (
  <Text accessibilityRole="header" style={{ color: tokens.color.text, fontSize: 17, fontWeight: "700" }}>
    {children}
  </Text>
)

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingVertical: 8,
      }}
    >
      <Text style={{ color: tokens.color.textSecondary, fontSize: 14 }}>{label}</Text>
      {typeof children === "string" ? (
        <Text style={{ color: tokens.color.text, fontSize: 14 }}>{children}</Text>
      ) : (
        children
      )}
    </View>
  )
}

// A read-only box that looks like the input of the reference: the command is detected by the doctor, not typed here.
function ReadOnlyField({
  label,
  value,
  mono = false,
}: {
  readonly label: string
  readonly value: string
  readonly mono?: boolean
}) {
  return (
    <View
      accessibilityLabel={label}
      style={{
        flex: 1,
        minHeight: 44,
        justifyContent: "center",
        paddingHorizontal: 12,
        borderRadius: tokens.radius.button,
        borderWidth: 1,
        borderColor: tokens.color.border,
        backgroundColor: tokens.color.surface,
      }}
    >
      <Text
        numberOfLines={1}
        style={{ color: tokens.color.text, fontSize: 14, fontFamily: mono ? tokens.font.mono : undefined }}
      >
        {value}
      </Text>
    </View>
  )
}

function Checkbox({
  checked,
  label,
  disabled,
  onChange,
}: {
  readonly checked: boolean
  readonly label: string
  readonly disabled: boolean
  readonly onChange: () => void
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={onChange}
      style={{
        width: 24,
        height: 24,
        borderRadius: 6,
        alignItems: "center",
        justifyContent: "center",
        borderWidth: 1,
        borderColor: checked ? tokens.color.accent : tokens.color.textSecondary,
        backgroundColor: checked ? tokens.color.accent : "transparent",
        opacity: disabled ? 0.55 : 1,
      }}
    >
      {checked ? <Icon name="check" size={16} color={tokens.color.white} strokeWidth={3} /> : null}
    </Pressable>
  )
}

function InfoSection({
  setting,
  checkedAt,
  now,
}: Pick<ExecutorDetailProps, "setting" | "checkedAt" | "now">) {
  const { t } = useLocale()
  const { view } = setting
  const status = view.status === null ? undefined : t(DOCTOR_LABEL[view.status])
  return (
    <Card style={{ gap: 2 }}>
      <SectionTitle>{t("settings.detail.info")}</SectionTitle>
      <Fact label={t("settings.detail.type")}>
        {view.cli === null
          ? t("settings.detail.typeAdapter")
          : t("settings.detail.typeCli", { name: setting.name })}
      </Fact>
      <Fact label={t("settings.detail.status")}>
        <View style={{ alignItems: "flex-end" }}>
          <ConnectionStatus connected={setting.connected} />
          {status === undefined || view.status === "ok" ? null : (
            <Text style={{ color: tokens.color.amber, fontSize: 13 }}>{status}</Text>
          )}
        </View>
      </Fact>
      <Fact label={t("settings.detail.checked")}>{agoLabel(checkedAt, now, t)}</Fact>
      <Fact label={t("settings.detail.version")}>{view.installedVersion ?? "—"}</Fact>
    </Card>
  )
}

function CommandSection({
  setting,
  probing,
  onTest,
}: {
  readonly setting: ExecutorSetting
  readonly probing: boolean
  readonly onTest: (id: string) => void
}) {
  const { t } = useLocale()
  return (
    <View style={{ gap: 8 }}>
      <SectionTitle>{t("settings.detail.command")}</SectionTitle>
      <Text style={{ color: tokens.color.textSecondary, fontSize: 14 }}>{t("settings.detail.path")}</Text>
      <View style={{ flexDirection: "row", gap: 10 }}>
        <ReadOnlyField label={t("settings.detail.path")} value={setting.view.cli ?? "—"} mono />
        <PrimaryButton
          label={t("settings.detail.detect")}
          variant="secondary"
          disabled={probing || setting.view.cli === null}
          onPress={() => onTest(setting.id)}
        />
      </View>
      <Text style={{ color: tokens.color.textSecondary, fontSize: 14, marginTop: 6 }}>
        {t("settings.detail.args")}
      </Text>
      <View style={{ flexDirection: "row" }}>
        <ReadOnlyField label={t("settings.detail.args")} value="—" mono />
      </View>
    </View>
  )
}

function ModelsSection({
  setting,
  onModel,
}: {
  readonly setting: ExecutorSetting
  readonly onModel: (id: string, model: string) => void
}) {
  const { t } = useLocale()
  return (
    <View style={{ gap: 10 }}>
      <SectionTitle>{t("settings.detail.models")}</SectionTitle>
      {setting.models.length === 0 ? (
        <Text style={{ color: tokens.color.textSecondary, fontSize: 14 }}>
          {t("settings.detail.noModels")}
        </Text>
      ) : (
        setting.models.map((model) => {
          const checked = setting.enabledModels.includes(model.id)
          return (
            <View
              key={model.id}
              style={{ flexDirection: "row", alignItems: "center", gap: 12, flexWrap: "wrap" }}
            >
              <Checkbox
                checked={checked}
                label={model.label}
                disabled={checked && setting.enabledModels.length <= 1}
                onChange={() => onModel(setting.id, model.id)}
              />
              <Text style={{ color: tokens.color.text, fontSize: 15 }}>{model.label}</Text>
              {model.tags.map((tag) => (
                <View
                  key={tag}
                  style={{
                    paddingHorizontal: 10,
                    paddingVertical: 4,
                    borderRadius: tokens.radius.chip,
                    backgroundColor: TAG_STYLE[tag].background,
                  }}
                >
                  <Text style={{ color: TAG_STYLE[tag].color, fontSize: 13 }}>{t(TAG_LABEL[tag])}</Text>
                </View>
              ))}
            </View>
          )
        })
      )}
    </View>
  )
}

function LimitsSection({
  setting,
  actions,
}: {
  readonly setting: ExecutorSetting
  readonly actions: ExecutorDetailActions
}) {
  const { t } = useLocale()
  return (
    <View style={{ gap: 12 }}>
      <SectionTitle>{t("settings.detail.limits")}</SectionTitle>
      <Text style={{ color: tokens.color.textSecondary, fontSize: 14 }}>
        {t("settings.detail.maxTokens")}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
        <Slider
          value={setting.maxTokens}
          min={MIN_MAX_TOKENS}
          max={MAX_MAX_TOKENS}
          step={1000}
          onChange={(value) => actions.onMaxTokens(setting.id, value)}
          label={t("settings.detail.maxTokens")}
          valueText={tokensLabel(setting.maxTokens)}
        />
        <Text style={{ width: 52, textAlign: "right", color: tokens.color.text, fontSize: 15 }}>
          {tokensLabel(setting.maxTokens)}
        </Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={{ color: tokens.color.text, fontSize: 14 }}>{t("settings.detail.allow")}</Text>
        <Toggle
          value={setting.enabled}
          onChange={(enabled) => actions.onEnabled(setting.id, enabled)}
          label={t("settings.detail.allow")}
        />
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={{ color: tokens.color.text, fontSize: 14 }}>{t("settings.detail.useDefault")}</Text>
        <Toggle
          value={setting.isDefault}
          onChange={(isDefault) => actions.onDefault(setting.id, isDefault)}
          label={t("settings.detail.useDefault")}
        />
      </View>
      <Fact label={t("settings.detail.cost")}>{usdLabel(costPer1kOf(setting.id))}</Fact>
    </View>
  )
}

// Logins as the doctor sees them: method and state per Bot, never a credential.
function CredentialsSection({ setting, botNames }: Pick<ExecutorDetailProps, "setting" | "botNames">) {
  const { t } = useLocale()
  const { logins } = setting.view
  return (
    <Card style={{ gap: 8 }}>
      <SectionTitle>{t("settings.detail.credentials")}</SectionTitle>
      {logins.length === 0 ? (
        <Text style={{ color: tokens.color.textSecondary, fontSize: 14 }}>{t("executors.login.none")}</Text>
      ) : (
        logins.map((login) => (
          <Fact key={login.botId} label={botNames[login.botId] ?? login.botId}>
            {`${t(LOGIN_LABEL[login.state])}${login.authMethod === null ? "" : ` · ${login.authMethod}`}`}
          </Fact>
        ))
      )}
    </Card>
  )
}

function AdvancedSection({ setting }: { readonly setting: ExecutorSetting }) {
  const { t } = useLocale()
  const { quota } = setting.view
  return (
    <Card style={{ gap: 2 }}>
      <SectionTitle>{t("settings.detail.advanced")}</SectionTitle>
      <Fact label={t("settings.detail.quotaUsed")}>{`${Math.round(quota.usedRatio * 100)}%`}</Fact>
      <Fact label={t("settings.detail.quotaState")}>
        {quota.available ? t("settings.detail.quotaAvailable") : t("settings.detail.quotaExhausted")}
      </Fact>
    </Card>
  )
}

// The right column of the Configuração screen: the executor that was opened, in four tabs.
export function ExecutorDetail({
  setting,
  width,
  probing,
  checkedAt,
  now,
  botNames,
  actions,
}: ExecutorDetailProps) {
  const { t } = useLocale()
  const [tab, setTab] = useState<DetailTab>("general")
  const tabs = [
    { id: "general", label: t("settings.detail.tab.general") },
    { id: "models", label: t("settings.detail.tab.models") },
    { id: "credentials", label: t("settings.detail.tab.credentials") },
    { id: "advanced", label: t("settings.detail.tab.advanced") },
  ] as const
  return (
    <View
      accessibilityLabel={t("settings.detail.label", { name: setting.name })}
      style={{
        ...(width === undefined ? { alignSelf: "stretch" } : { width }),
        borderLeftWidth: width === undefined ? 0 : 1,
        borderLeftColor: tokens.color.border,
        backgroundColor: tokens.color.background,
      }}
    >
      <ScrollView contentContainerStyle={{ padding: 14, gap: 14 }}>
        <Card style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <ExecutorIcon family={familyOf(setting.id)} />
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Text numberOfLines={1} style={{ color: tokens.color.text, fontSize: 18, fontWeight: "700" }}>
              {setting.name}
            </Text>
            <ConnectionStatus connected={setting.connected} />
          </View>
          <PrimaryButton
            label={t("settings.detail.test")}
            variant="secondary"
            disabled={probing || setting.view.cli === null}
            {...(setting.view.cli === null ? { hint: t("settings.detail.noCli") } : {})}
            onPress={() => actions.onTest(setting.id)}
          />
          <IconButton
            icon="more"
            label={t("settings.detail.more")}
            size={36}
            color={tokens.color.textSecondary}
          />
        </Card>
        <Tabs tabs={tabs} active={tab} onChange={setTab} label={t("settings.detail.tabs")} variant="text" />
        {tab === "general" ? (
          <>
            <InfoSection setting={setting} checkedAt={checkedAt} now={now} />
            <CommandSection setting={setting} probing={probing} onTest={actions.onTest} />
            <ModelsSection setting={setting} onModel={actions.onModel} />
            <LimitsSection setting={setting} actions={actions} />
          </>
        ) : null}
        {tab === "models" ? <ModelsSection setting={setting} onModel={actions.onModel} /> : null}
        {tab === "credentials" ? <CredentialsSection setting={setting} botNames={botNames} /> : null}
        {tab === "advanced" ? <LimitsSection setting={setting} actions={actions} /> : null}
        {tab === "advanced" ? <AdvancedSection setting={setting} /> : null}
      </ScrollView>
    </View>
  )
}
