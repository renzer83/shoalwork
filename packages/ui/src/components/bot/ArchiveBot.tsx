import { useState } from "react"
import { View } from "react-native"
import { Button, HelperText, Text } from "react-native-paper"
import type { BotArchive } from "../../hooks/useBotArchive.js"
import { useLocale } from "../../i18n/index.js"

export interface ArchiveBotProps {
  readonly archived: boolean
  readonly archive: BotArchive
}

// Archiving asks for a second press: the first one opens the confirmation. An archived Bot shows only that it is.
export function ArchiveBot({ archived, archive }: ArchiveBotProps) {
  const [confirming, setConfirming] = useState(false)
  const { t } = useLocale()

  if (archived) {
    return <Text variant="bodySmall">{t("bot.archive.archived")}</Text>
  }

  return (
    <View style={{ gap: 6 }}>
      {confirming ? (
        <>
          <Text variant="bodySmall">{t("bot.archive.confirmQuestion")}</Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button
              mode="contained"
              disabled={archive.pending}
              onPress={() => {
                setConfirming(false)
                archive.run()
              }}
            >
              {t("bot.archive.confirm")}
            </Button>
            <Button disabled={archive.pending} onPress={() => setConfirming(false)}>
              {t("bot.archive.keep")}
            </Button>
          </View>
        </>
      ) : (
        <Button mode="outlined" disabled={archive.pending} onPress={() => setConfirming(true)}>
          {t("bot.archive.archive")}
        </Button>
      )}
      {archive.failure === null ? null : (
        <HelperText type="error">{t("bot.archive.failed", { status: archive.failure.status })}</HelperText>
      )}
    </View>
  )
}
