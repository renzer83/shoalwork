import type { NewBot } from "@shoalwork/contracts"
import { Effect, Struct } from "effect"
import { useState } from "react"
import { ScrollView, View } from "react-native"
import { ActivityIndicator, Card, Text, useTheme } from "react-native-paper"
import { useApi } from "../api-context.js"
import { AppBar } from "../components/AppBar.js"
import { ArchiveBot } from "../components/bot/ArchiveBot.js"
import { BotControls } from "../components/bot/BotControls.js"
import { BotForm } from "../components/bot/BotForm.js"
import { BudgetBar } from "../components/bot/BudgetBar.js"
import { draftOf } from "../components/bot/bot-form-model.js"
import { MemoryList } from "../components/bot/MemoryList.js"
import { TankBadge } from "../components/bot/TankBadge.js"
import { ErrorBanner } from "../components/ErrorBanner.js"
import { useBot } from "../hooks/useBot.js"
import { useBotArchive } from "../hooks/useBotArchive.js"
import { useBotControl } from "../hooks/useBotControl.js"
import { useBotMemory } from "../hooks/useBotMemory.js"
import { useLocale } from "../i18n/index.js"

export interface BotScreenProps {
  readonly idOrName: string
}

// The ficha of one Bot: state, role, instructions (as text), executors, connectors, budget, Tank and memory.
export function BotScreen({ idOrName }: BotScreenProps) {
  const theme = useTheme()
  const { t } = useLocale()
  const { load, reload } = useBot(idOrName)
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <AppBar title={load.kind === "loaded" ? load.bot.name : t("bot.fallbackTitle")} onRefresh={reload} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        {load.kind === "loading" ? <ActivityIndicator accessibilityLabel={t("common.loading")} /> : null}
        {load.kind === "failed" ? (
          <ErrorBanner message={t("bot.loadFailed", { status: load.status })} onRetry={reload} />
        ) : null}
        {load.kind === "loaded" ? (
          <BotBody bot={load.bot} costUsd24h={load.costUsd24h} onChanged={reload} />
        ) : null}
      </ScrollView>
    </View>
  )
}

interface BotBodyProps {
  readonly bot: Extract<ReturnType<typeof useBot>["load"], { kind: "loaded" }>["bot"]
  readonly costUsd24h: number | undefined
  // Re-reads the ficha after a save or a pause/resume.
  readonly onChanged: () => void
}

const statusOf = (error: unknown): number =>
  error instanceof Object && "status" in error ? Number(error.status) : 0

function BotBody({ bot, costUsd24h, onChanged }: BotBodyProps) {
  const { client } = useApi()
  const { t } = useLocale()
  const memory = useBotMemory(bot.id)
  const control = useBotControl(bot.id, onChanged)
  const archive = useBotArchive(bot.id, onChanged)
  const [notice, setNotice] = useState<string | null>(null)

  // The name is the file name and is not sent; the core refuses it anyway.
  const save = (next: NewBot) => {
    setNotice(null)
    void Effect.runPromise(Effect.result(client.bots.patch(bot.id, Struct.omit(next, ["name"])))).then(
      (result) => {
        if (result._tag === "Success") {
          setNotice(t("bot.saved"))
          onChanged()
        } else {
          setNotice(t("bot.saveFailed", { status: statusOf(result.failure) }))
        }
      },
    )
  }

  return (
    <>
      <Card>
        <Card.Content style={{ gap: 6 }}>
          <Text variant="titleLarge">{bot.name}</Text>
          <Text variant="labelLarge">{t("bot.stateLine", { state: bot.state })}</Text>
          <Text variant="bodyMedium">{bot.role}</Text>
          <Text variant="labelMedium">{t("bot.instructions")}</Text>
          <Text variant="bodyMedium">{bot.instructions}</Text>
          <Text variant="labelMedium">
            {t("bot.executorsLine", {
              preferred: bot.executors.preferred,
              allowed: bot.executors.allowed.join(", "),
            })}
          </Text>
          <Text variant="labelMedium">
            {t("bot.connectorsLine", {
              connectors: bot.connectors.length === 0 ? t("common.none") : bot.connectors.join(", "),
            })}
          </Text>
          <TankBadge mode={bot.tank.mode} host={bot.tank.host} />
          <BotControls state={bot.state} control={control} />
          <ArchiveBot archived={bot.state === "archived"} archive={archive} />
          {costUsd24h === undefined ? (
            <Text variant="labelLarge">{t("bot.costUnavailable", { usd: bot.budget.usd })}</Text>
          ) : (
            <BudgetBar label={t("bot.costLabel")} used={costUsd24h} limit={bot.budget.usd} unit="USD" />
          )}
        </Card.Content>
      </Card>
      <Card>
        <Card.Content style={{ gap: 8 }}>
          <Text variant="titleMedium">{t("bot.profile")}</Text>
          <BotForm initial={draftOf(bot)} onSubmit={save} />
          {notice === null ? null : <Text variant="bodySmall">{notice}</Text>}
        </Card.Content>
      </Card>
      <Card>
        <Card.Content style={{ gap: 8 }}>
          <Text variant="titleMedium">{t("bot.memory")}</Text>
          <MemoryList
            load={memory.load}
            onSearch={memory.search}
            onForget={memory.forget}
            onEdit={memory.edit}
            onHistory={memory.history}
          />
        </Card.Content>
      </Card>
    </>
  )
}
