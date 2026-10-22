import type { BotSummary } from "@shoalwork/api-client"
import { Pressable, Text, View } from "react-native"
import { Avatar } from "../components/v2/Avatar.js"
import { useLocale } from "../i18n/index.js"
import { tokens } from "../theme.js"
import { type BotPreview, whenLabel } from "./bot-groups.js"

export interface BotRowProps {
  readonly bot: BotSummary
  readonly preview: BotPreview | undefined
  readonly active: boolean
  readonly onPress: (bot: BotSummary) => void
  // Test seam: the clock used for "today" and "yesterday".
  readonly now?: () => number
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim()

// avatar + name + last message (truncated) + time. The active row is a translucent blue pill.
export function BotRow({ bot, preview, active, onPress, now = Date.now }: BotRowProps) {
  const { t } = useLocale()
  const when = preview === undefined ? undefined : whenLabel(preview.at, now(), t)
  const label =
    preview === undefined ? bot.name : [bot.name, oneLine(preview.text), when].filter(Boolean).join(", ")
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      aria-current={active ? "page" : undefined}
      onPress={() => onPress(bot)}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 14,
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderRadius: tokens.radius.card,
        backgroundColor: active ? tokens.color.accentSoft : pressed ? tokens.color.surface : "transparent",
      })}
    >
      <Avatar id={bot.id} size={44} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text numberOfLines={1} style={{ color: tokens.color.text, fontSize: 16, fontWeight: "600" }}>
          {bot.name}
        </Text>
        <Text numberOfLines={1} style={{ color: tokens.color.textSecondary, fontSize: 14 }}>
          {preview === undefined ? t("shell.noMessages") : oneLine(preview.text)}
        </Text>
      </View>
      {preview === undefined ? null : (
        <Text style={{ color: active ? tokens.color.link : tokens.color.textSecondary, fontSize: 13 }}>
          {when}
        </Text>
      )}
    </Pressable>
  )
}
