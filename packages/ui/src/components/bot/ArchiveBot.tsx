import { useState } from "react"
import { View } from "react-native"
import { Button, HelperText, Text } from "react-native-paper"
import type { BotArchive } from "../../hooks/useBotArchive.js"

export interface ArchiveBotProps {
  readonly archived: boolean
  readonly archive: BotArchive
}

// Archiving asks for a second press: the first one opens the confirmation. An archived Bot shows only that it is.
export function ArchiveBot({ archived, archive }: ArchiveBotProps) {
  const [confirming, setConfirming] = useState(false)

  if (archived) {
    return (
      <Text variant="bodySmall">Archived: this Bot takes no new tasks. Its memory and history stay.</Text>
    )
  }

  return (
    <View style={{ gap: 6 }}>
      {confirming ? (
        <>
          <Text variant="bodySmall">
            Archive this Bot? It takes no new tasks. Its memory and history stay.
          </Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button
              mode="contained"
              disabled={archive.pending}
              onPress={() => {
                setConfirming(false)
                archive.run()
              }}
            >
              Confirm archive
            </Button>
            <Button disabled={archive.pending} onPress={() => setConfirming(false)}>
              Keep
            </Button>
          </View>
        </>
      ) : (
        <Button mode="outlined" disabled={archive.pending} onPress={() => setConfirming(true)}>
          Archive
        </Button>
      )}
      {archive.failure === null ? null : (
        <HelperText type="error">{`archive failed (HTTP ${archive.failure.status})`}</HelperText>
      )}
    </View>
  )
}
