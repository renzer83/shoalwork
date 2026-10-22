import type { BotSummary } from "@shoalwork/api-client"
import { useEffect, useMemo, useState } from "react"
import { Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native"
import { ErrorBanner } from "../components/ErrorBanner.js"
import { Icon } from "../components/v2/Icon.js"
import { IconButton } from "../components/v2/IconButton.js"
import { useBotPreviews } from "../hooks/useBotPreviews.js"
import { useBots } from "../hooks/useBots.js"
import { useLocale } from "../i18n/index.js"
import { NewBotScreen } from "../screens/NewBotScreen.js"
import { tokens } from "../theme.js"
import { BotGroupList } from "./BotGroupList.js"
import { chatTarget, GUIDE_NAME, groupBots } from "./bot-groups.js"
import { botStatus } from "./bot-status.js"
import { GuideHero } from "./GuideHero.js"
import { TrafficLightsSpacer } from "./TrafficLightsSpacer.js"

export interface SidebarProps {
  readonly width: number
  readonly pathname: string
  readonly onNavigate: (href: string) => void
  readonly searchOpen: boolean
  readonly onSearchOpenChange: (open: boolean) => void
}

export const SETTINGS_HREF = "/settings"
export const chatHref = (nameOrId: string): string => `/chat/${encodeURIComponent(nameOrId)}`

export function Sidebar({ width, pathname, onNavigate, searchOpen, onSearchOpenChange }: SidebarProps) {
  const { t } = useLocale()
  const { load, reload } = useBots()
  const [filter, setFilter] = useState("")
  const [creating, setCreating] = useState(false)

  // Closing the search, from its button or from outside, drops the filter: the whole list is back.
  useEffect(() => {
    if (!searchOpen) setFilter("")
  }, [searchOpen])

  const bots: ReadonlyArray<BotSummary> = load.kind === "loaded" ? load.rows : []
  const previews = useBotPreviews(useMemo(() => bots.map((bot) => bot.id), [bots]))
  const groups = useMemo(() => groupBots(bots, t, filter), [bots, t, filter])
  const guide = bots.find((bot) => bot.name === GUIDE_NAME)
  const settingsActive = pathname === SETTINGS_HREF || pathname.startsWith(`${SETTINGS_HREF}/`)

  return (
    <View
      accessibilityLabel={t("shell.sidebar")}
      role="navigation"
      style={{
        width,
        backgroundColor: tokens.color.background,
        borderRightWidth: 1,
        borderRightColor: tokens.color.border,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          paddingHorizontal: 18,
          paddingTop: 16,
          paddingBottom: 8,
        }}
      >
        <TrafficLightsSpacer />
        <View
          style={{
            width: 34,
            height: 34,
            borderRadius: 10,
            backgroundColor: tokens.color.elevated,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text style={{ color: tokens.color.accent, fontSize: 22, fontWeight: "800", lineHeight: 26 }}>
            ~
          </Text>
        </View>
        <Text style={{ flex: 1, color: tokens.color.text, fontSize: 20, fontWeight: "700" }}>
          {t("shell.brand")}
        </Text>
        <IconButton
          icon="search"
          label={t("shell.search")}
          round
          background={tokens.color.surface}
          onPress={() => onSearchOpenChange(!searchOpen)}
        />
        <IconButton
          icon="plus"
          label={t("shell.newBot")}
          round
          background={tokens.color.surface}
          onPress={() => setCreating(true)}
        />
      </View>

      {searchOpen ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            marginHorizontal: 18,
            marginBottom: 6,
            paddingHorizontal: 12,
            borderRadius: tokens.radius.button,
            backgroundColor: tokens.color.surface,
          }}
        >
          <Icon name="search" size={16} color={tokens.color.textSecondary} />
          <TextInput
            autoFocus
            value={filter}
            onChangeText={setFilter}
            placeholder={t("shell.searchPlaceholder")}
            placeholderTextColor={tokens.color.textSecondary}
            accessibilityLabel={t("shell.searchPlaceholder")}
            style={{ flex: 1, color: tokens.color.text, fontSize: 15, paddingVertical: 10, outlineWidth: 0 }}
          />
        </View>
      ) : null}

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 12 }}>
        <GuideHero status={botStatus(guide?.state, t)} onPress={() => onNavigate(chatHref(GUIDE_NAME))} />
        <View style={{ height: 1, backgroundColor: tokens.color.border, marginBottom: 6 }} />
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
        {load.kind === "loaded" && groups.length === 0 ? (
          <Text style={{ color: tokens.color.textSecondary, padding: 12 }}>
            {filter === "" ? t("shell.noBots") : t("shell.noMatch")}
          </Text>
        ) : null}
        <BotGroupList
          groups={groups}
          previews={previews}
          activeRef={chatTarget(pathname)}
          onOpen={(bot) => onNavigate(chatHref(bot.name))}
        />
      </ScrollView>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("shell.settings")}
        aria-current={settingsActive ? "page" : undefined}
        onPress={() => onNavigate(SETTINGS_HREF)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          margin: 14,
          paddingVertical: 12,
          paddingHorizontal: 14,
          borderRadius: tokens.radius.button,
          backgroundColor: settingsActive ? tokens.color.accentSoft : "transparent",
        }}
      >
        <Icon name="gear" size={20} color={settingsActive ? tokens.color.link : tokens.color.textSecondary} />
        <Text
          style={{
            color: settingsActive ? tokens.color.link : tokens.color.text,
            fontSize: 16,
            fontWeight: "600",
          }}
        >
          {t("shell.settings")}
        </Text>
      </Pressable>

      <Modal visible={creating} transparent animationType="none" onRequestClose={() => setCreating(false)}>
        <View
          style={{
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: tokens.color.scrim,
            padding: 24,
          }}
        >
          <View
            style={{
              width: "100%",
              maxWidth: 560,
              height: "85%",
              borderRadius: tokens.radius.card,
              overflow: "hidden",
              backgroundColor: tokens.color.background,
              borderWidth: 1,
              borderColor: tokens.color.border,
            }}
          >
            <View style={{ alignItems: "flex-end", padding: 8 }}>
              <IconButton
                icon="close"
                label={t("shell.closeNewBot")}
                onPress={() => setCreating(false)}
                size={36}
              />
            </View>
            <NewBotScreen
              onCreated={(name) => {
                setCreating(false)
                reload()
                onNavigate(chatHref(name))
              }}
            />
          </View>
        </View>
      </Modal>
    </View>
  )
}
