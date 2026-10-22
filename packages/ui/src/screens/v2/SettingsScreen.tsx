import { useEffect, useMemo, useState } from "react"
import { ScrollView, useWindowDimensions, View } from "react-native"
import { useApi } from "../../api-context.js"
import { ErrorBanner } from "../../components/ErrorBanner.js"
import { ExecutorDetail, type ExecutorDetailActions } from "../../components/v2/settings/ExecutorDetail.js"
import { familyOf } from "../../components/v2/settings/executor-catalog.js"
import { SettingsHeader } from "../../components/v2/settings/SettingsHeader.js"
import {
  clearDefault,
  type ExecutorSetting,
  type RouteEntry,
  routingOf,
  setDefault,
  setEnabled,
  setMainModel,
  setMaxTokens,
  setPriority,
  settingsOf,
  toggleModel,
  withRouting,
} from "../../components/v2/settings/settings-model.js"
import { Tabs } from "../../components/v2/settings/Tabs.js"
import { AppsTab } from "../../components/v2/settings/tabs/AppsTab.js"
import { ExecutorsTab } from "../../components/v2/settings/tabs/ExecutorsTab.js"
import { type GeneralDraft, GeneralTab } from "../../components/v2/settings/tabs/GeneralTab.js"
import { PoliciesTab } from "../../components/v2/settings/tabs/PoliciesTab.js"
import { RoutingTab } from "../../components/v2/settings/tabs/RoutingTab.js"
import { useBotNames } from "../../hooks/useBotNames.js"
import { useExecutors } from "../../hooks/useExecutors.js"
import { useSettingsPreferences } from "../../hooks/useSettingsPreferences.js"
import { useLocale } from "../../i18n/index.js"
import { useShell } from "../../shell/shell-context.js"
import { shellMetrics } from "../../shell/shell-metrics.js"
import type { KeyValueStore } from "../../storage.js"
import { tokens } from "../../theme.js"

export type SettingsTab = "executors" | "apps" | "routing" | "policies" | "general"

export interface SettingsScreenProps {
  // Test seams: where the choices are kept, and the clock of "última verificação".
  readonly store?: KeyValueStore
  readonly now?: () => number
}

// The Configuração screen of the v2 design: five tabs in the middle and, on the Executores tab, the detail of the
// selected executor in the right column.
export function SettingsScreen({ store, now = Date.now }: SettingsScreenProps) {
  const { t, locale, setLocale } = useLocale()
  const { narrow, openList } = useShell()
  const { width } = useWindowDimensions()
  const { config, ready, save: saveCore } = useApi()
  const executors = useExecutors()
  const preferences = useSettingsPreferences(store)
  const botNames = useBotNames()
  const [tab, setTab] = useState<SettingsTab>("executors")
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const [checkedAt, setCheckedAt] = useState<Readonly<Record<string, number>>>({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const views = executors.load.kind === "loaded" ? executors.load.value : []
  const settings = useMemo(() => settingsOf(views, preferences.draft), [views, preferences.draft])
  const selected = settings.find((setting) => setting.id === selectedId) ?? settings[0]
  const routing = useMemo(() => routingOf(settings, preferences.draft), [settings, preferences.draft])
  const names = useMemo(() => Object.fromEntries(botNames.map((bot) => [bot.id, bot.name])), [botNames])
  const panelWidth = shellMetrics(width).panelWidth

  // The General tab: seeded from the saved address and language, then edited until saved.
  const [general, setGeneral] = useState<GeneralDraft>({
    baseUrl: config.baseUrl,
    token: config.token ?? "",
    locale,
  })
  const [generalEdited, setGeneralEdited] = useState(false)
  useEffect(() => {
    if (ready && !generalEdited) {
      setGeneral({ baseUrl: config.baseUrl, token: config.token ?? "", locale })
    }
  }, [ready, generalEdited, config.baseUrl, config.token, locale])
  const coreDirty = general.baseUrl.trim() !== config.baseUrl || general.token.trim() !== (config.token ?? "")
  const generalDirty = coreDirty || general.locale !== locale
  const dirty = preferences.dirty || generalDirty

  const edit = (change: Parameters<typeof preferences.edit>[0]) => preferences.edit(change)
  const settingOf = (id: string, current = preferences.draft): ExecutorSetting | undefined =>
    settingsOf(views, current).find((setting) => setting.id === id)

  const actions: ExecutorDetailActions = {
    onTest: (id) => {
      setCheckedAt((current) => ({ ...current, [id]: now() }))
      executors.reprobe(id)
    },
    onEnabled: (id, enabled) => edit((current) => setEnabled(current, id, enabled)),
    onDefault: (id, isDefault) =>
      edit((current) => (isDefault ? setDefault(current, id) : clearDefault(views, current, id))),
    onModel: (id, model) =>
      edit((current) => {
        const setting = settingOf(id, current)
        return setting === undefined ? current : toggleModel(current, setting, model)
      }),
    onMaxTokens: (id, amount) => edit((current) => setMaxTokens(current, id, amount)),
  }

  const onRouting = (entries: ReadonlyArray<RouteEntry>) => edit((current) => withRouting(current, entries))

  const submit = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      if (preferences.dirty) await preferences.save()
      if (general.locale !== locale) await setLocale(general.locale)
      if (coreDirty) {
        const token = general.token.trim()
        await saveCore({ baseUrl: general.baseUrl.trim(), token: token === "" ? null : token })
      }
      setGeneralEdited(false)
    } catch {
      setSaveError(t("settings.saveFailed"))
    } finally {
      setSaving(false)
    }
  }

  const detail =
    tab === "executors" && selected !== undefined ? (
      <ExecutorDetail
        key={selected.id}
        setting={selected}
        {...(panelWidth > 0 ? { width: panelWidth } : {})}
        probing={executors.probing === selected.id}
        checkedAt={checkedAt[selected.id]}
        now={now()}
        botNames={names}
        actions={actions}
      />
    ) : null

  const tabs = [
    { id: "executors", label: t("settings.tab.executors"), icon: "grid" },
    { id: "apps", label: t("settings.tab.apps"), icon: "plug" },
    { id: "routing", label: t("settings.tab.routing"), icon: "route" },
    { id: "policies", label: t("settings.tab.policies"), icon: "shield" },
    { id: "general", label: t("settings.tab.general"), icon: "circleDots" },
  ] as const

  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: tokens.color.background }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <SettingsHeader
          family={selected === undefined ? "other" : familyOf(selected.id)}
          dirty={dirty}
          saving={saving}
          onSave={() => void submit()}
          onBack={narrow ? openList : undefined}
        />
        <View style={{ paddingHorizontal: 20, paddingBottom: 12 }}>
          <Tabs tabs={tabs} active={tab} onChange={setTab} label={t("settings.tabs")} />
        </View>
        <ScrollView contentContainerStyle={{ padding: 20, paddingTop: 12, gap: 16 }}>
          {saveError === null ? null : <ErrorBanner message={saveError} />}
          {tab === "executors" ? (
            <ExecutorsTab
              load={executors.load}
              onReload={executors.reload}
              probeFailure={executors.probeFailure}
              settings={settings}
              selectedId={selected?.id}
              routing={routing}
              onRouting={onRouting}
              onSelect={setSelectedId}
              onToggle={actions.onEnabled}
              onPriority={(id, priority) => edit((current) => setPriority(views, current, id, priority))}
              onModel={(id, model) =>
                edit((current) => {
                  const setting = settingOf(id, current)
                  return setting === undefined ? current : setMainModel(current, setting, model)
                })
              }
              {...(panelWidth === 0 && detail !== null ? { inlineDetail: detail } : {})}
            />
          ) : null}
          {tab === "apps" ? <AppsTab /> : null}
          {tab === "routing" ? <RoutingTab routing={routing} onRouting={onRouting} /> : null}
          {tab === "policies" ? <PoliciesTab /> : null}
          {tab === "general" ? (
            <GeneralTab
              draft={general}
              onChange={(next) => {
                setGeneralEdited(true)
                setGeneral(next)
              }}
            />
          ) : null}
        </ScrollView>
      </View>
      {panelWidth > 0 ? detail : null}
    </View>
  )
}
