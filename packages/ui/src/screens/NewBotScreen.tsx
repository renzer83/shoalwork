import type { NewBot } from "@shoalwork/contracts"
import { Effect } from "effect"
import { useState } from "react"
import { ScrollView, View } from "react-native"
import { useTheme } from "react-native-paper"
import { useApi } from "../api-context.js"
import { AppBar } from "../components/AppBar.js"
import { BotForm } from "../components/bot/BotForm.js"
import { EMPTY_DRAFT } from "../components/bot/bot-form-model.js"
import { ErrorBanner } from "../components/ErrorBanner.js"
import { useLocale } from "../i18n/index.js"

export interface NewBotScreenProps {
  // Receives the new Bot's name: the route opens it by name.
  readonly onCreated?: (name: string) => void
}

// A new Bot from the same ficha as the Bot screen. The core writes bots/<name>.yaml and the registry row together.
export function NewBotScreen({ onCreated }: NewBotScreenProps) {
  const { client } = useApi()
  const theme = useTheme()
  const { t } = useLocale()
  const [notice, setNotice] = useState<string | null>(null)

  const create = (bot: NewBot) => {
    setNotice(null)
    void Effect.runPromise(Effect.result(client.bots.create(bot))).then((result) => {
      if (result._tag === "Success") {
        onCreated?.(result.success.bot.name)
        return
      }
      const error: unknown = result.failure
      const status = error instanceof Object && "status" in error ? Number(error.status) : 0
      setNotice(t("newBot.failed", { status }))
    })
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <AppBar title={t("newBot.title")} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        <BotForm initial={EMPTY_DRAFT} onSubmit={create} />
        {notice === null ? null : <ErrorBanner message={notice} />}
      </ScrollView>
    </View>
  )
}
