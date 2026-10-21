import { useState } from "react"
import { Platform, View } from "react-native"
import { Button, Text, TextInput, useTheme } from "react-native-paper"
import { useLocale } from "../../i18n/index.js"

export const MAX_MESSAGE_CHARS = 8000

export interface ComposerProps {
  readonly sending: boolean
  readonly error?: string | undefined
  // Resolves true when the message was accepted; the field is cleared then.
  readonly onSend: (text: string) => Promise<boolean>
}

// Plain Enter sends where there is a hardware keyboard (web, desktop); Shift+Enter breaks the line. The virtual
// keyboards of the phone keep Enter as a new line.
const isPlainEnter = (native: object): boolean =>
  Platform.OS === "web" && Reflect.get(native, "key") === "Enter" && Reflect.get(native, "shiftKey") !== true

export function Composer({ sending, error, onSend }: ComposerProps) {
  const theme = useTheme()
  const { t } = useLocale()
  const [text, setText] = useState("")
  const empty = text.trim() === ""

  const submit = async (): Promise<void> => {
    if (sending || empty) return
    if (await onSend(text)) setText("")
  }

  return (
    <View style={{ padding: 8, gap: 4, borderTopWidth: 1, borderTopColor: theme.colors.outlineVariant }}>
      {error === undefined ? null : (
        <Text accessibilityRole="alert" style={{ fontSize: 14, color: theme.colors.error }}>
          {error}
        </Text>
      )}
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
        <TextInput
          style={{ flex: 1, fontSize: 15, maxHeight: 140 }}
          mode="outlined"
          multiline
          dense
          placeholder={t("chat.composer.placeholder")}
          accessibilityLabel={t("chat.composer.placeholder")}
          maxLength={MAX_MESSAGE_CHARS}
          value={text}
          onChangeText={setText}
          editable={!sending}
          onKeyPress={(event) => {
            if (isPlainEnter(event.nativeEvent)) {
              event.preventDefault()
              void submit()
            }
          }}
        />
        <Button
          mode="contained"
          accessibilityLabel={t("chat.composer.send")}
          disabled={sending || empty}
          loading={sending}
          onPress={() => void submit()}
        >
          {sending ? t("chat.composer.sending") : t("chat.composer.send")}
        </Button>
      </View>
    </View>
  )
}
