import { useRef, useState } from "react"
import { Platform, Text, TextInput, View } from "react-native"
import { useLocale } from "../../../i18n/index.js"
import { tokens } from "../../../theme.js"
import { IconButton } from "../IconButton.js"

export const MAX_MESSAGE_CHARS = 8000
const INPUT_MIN_HEIGHT = 22
const INPUT_MAX_HEIGHT = 120

export interface ComposerProps {
  readonly botName: string
  readonly sending: boolean
  readonly error?: string | undefined
  // Resolves true when the message was accepted; the field is cleared then.
  readonly onSend: (text: string) => Promise<boolean>
}

type KeyAction = "send" | "newline" | "default"

// Enter sends and ⌘↵ (or Ctrl↵) breaks the line, where there is a hardware keyboard (web, desktop). Shift+Enter keeps
// the browser's own line break. The virtual keyboards of the phone keep Enter as a new line. An Enter that confirms
// an IME candidate (Japanese, Chinese, Korean...) is not a send: the browser flags it `isComposing` / keyCode 229.
export const keyAction = (native: object): KeyAction => {
  if (Platform.OS !== "web" || Reflect.get(native, "key") !== "Enter") return "default"
  if (Reflect.get(native, "isComposing") === true || Reflect.get(native, "keyCode") === 229) return "default"
  if (Reflect.get(native, "metaKey") === true || Reflect.get(native, "ctrlKey") === true) return "newline"
  return Reflect.get(native, "shiftKey") === true ? "default" : "send"
}

// The text with `insert` in place of the selection [start, end).
export const insertAt = (text: string, start: number, end: number, insert: string): string =>
  `${text.slice(0, start)}${insert}${text.slice(end)}`

interface Selection {
  readonly start: number
  readonly end: number
}

export function Composer({ botName, sending, error, onSend }: ComposerProps) {
  const { t } = useLocale()
  const [text, setText] = useState("")
  const [inputHeight, setInputHeight] = useState(INPUT_MIN_HEIGHT)
  const empty = text.trim() === ""
  // Where the caret is, kept from the input's own selection events; the end of the text until it reports one.
  const caret = useRef<Selection | undefined>(undefined)
  // Set only to move the caret after a line break was inserted; the next selection event clears it.
  const [moveCaret, setMoveCaret] = useState<Selection | undefined>(undefined)

  const submit = async (): Promise<void> => {
    if (sending || empty) return
    if (await onSend(text)) setText("")
  }

  return (
    <View style={{ paddingHorizontal: 16, paddingBottom: 14, paddingTop: 8, gap: 6 }}>
      {error === undefined ? null : (
        <Text accessibilityRole="alert" style={{ color: tokens.color.red, fontSize: 14 }}>
          {error}
        </Text>
      )}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <IconButton
          icon="paperclip"
          label={t("conv.composer.attach")}
          disabled
          round
          size={48}
          color={tokens.color.textSecondary}
          background={tokens.color.surface}
        />
        <View
          style={{
            flex: 1,
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            minHeight: 54,
            paddingLeft: 16,
            paddingRight: 6,
            borderRadius: tokens.radius.card,
            borderWidth: 1,
            borderColor: tokens.color.border,
            backgroundColor: tokens.color.surface,
          }}
        >
          <TextInput
            style={{
              flex: 1,
              color: tokens.color.text,
              fontSize: tokens.font.size,
              height: inputHeight,
              paddingVertical: 0,
              marginVertical: 16,
              outlineWidth: 0,
            }}
            multiline
            numberOfLines={1}
            {...(moveCaret === undefined ? {} : { selection: moveCaret })}
            onSelectionChange={(event) => {
              caret.current = event.nativeEvent.selection
              if (moveCaret !== undefined) setMoveCaret(undefined)
            }}
            onContentSizeChange={(event) =>
              setInputHeight(
                Math.min(INPUT_MAX_HEIGHT, Math.max(INPUT_MIN_HEIGHT, event.nativeEvent.contentSize.height)),
              )
            }
            placeholder={t("conv.composer.placeholder", { bot: botName })}
            placeholderTextColor={tokens.color.textSecondary}
            accessibilityLabel={t("conv.composer.placeholder", { bot: botName })}
            maxLength={MAX_MESSAGE_CHARS}
            value={text}
            onChangeText={setText}
            editable={!sending}
            onKeyPress={(event) => {
              const action = keyAction(event.nativeEvent)
              if (action === "send") {
                event.preventDefault()
                void submit()
              } else if (action === "newline") {
                event.preventDefault()
                const at = caret.current ?? { start: text.length, end: text.length }
                const next = at.start + 1
                setText(insertAt(text, at.start, at.end, "\n"))
                caret.current = { start: next, end: next }
                setMoveCaret({ start: next, end: next })
              }
            }}
          />
          <Text numberOfLines={1} style={{ color: tokens.color.textSecondary, fontSize: 13 }}>
            {t("conv.composer.hint")}
          </Text>
          <IconButton
            icon="mic"
            label={t("conv.composer.mic")}
            disabled
            size={40}
            color={tokens.color.textSecondary}
          />
        </View>
        <IconButton
          icon="send"
          label={t("conv.composer.send")}
          disabled={sending || empty}
          onPress={() => void submit()}
          size={48}
          color={tokens.color.text}
          background={tokens.color.accent}
        />
      </View>
    </View>
  )
}
