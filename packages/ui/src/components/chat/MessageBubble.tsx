import { View } from "react-native"
import { Text, useTheme } from "react-native-paper"
import { useLocale } from "../../i18n/index.js"

export interface MessageBubbleProps {
  readonly direction: "in" | "out"
  readonly text: string
  readonly time: string
  readonly channel: string
}

// "in" is what the user wrote (right side), "out" is the Bot's answer. The text is plain data: no markup is parsed.
export function MessageBubble({ direction, text, time, channel }: MessageBubbleProps) {
  const theme = useTheme()
  const { t } = useLocale()
  const mine = direction === "in"
  return (
    <View
      accessibilityLabel={mine ? t("chat.bubble.you", { time }) : t("chat.bubble.bot", { time })}
      style={{
        alignSelf: mine ? "flex-end" : "flex-start",
        maxWidth: "85%",
        backgroundColor: mine ? theme.colors.primaryContainer : theme.colors.surfaceVariant,
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingVertical: 8,
        gap: 2,
      }}
    >
      <Text selectable style={{ fontSize: 15 }}>
        {text}
      </Text>
      <Text style={{ fontSize: 14, color: theme.colors.outline }}>{`${time} · ${channel}`}</Text>
    </View>
  )
}
