import type { BotSummary } from "@shoalwork/api-client"
import { useState } from "react"
import { Pressable, Text, View } from "react-native"
import { Icon } from "../components/v2/Icon.js"
import { useLocale } from "../i18n/index.js"
import { tokens } from "../theme.js"
import { BotRow } from "./BotRow.js"
import { type BotGroup, type BotPreview, isBotRef } from "./bot-groups.js"

export interface BotGroupListProps {
  readonly groups: ReadonlyArray<BotGroup>
  readonly previews: Readonly<Record<string, BotPreview>>
  // The Bot the open chat belongs to (an id or a name).
  readonly activeRef: string | undefined
  readonly onOpen: (bot: BotSummary) => void
  readonly now?: () => number
}

// Bots under a header per project: name, count and a chevron that folds the group.
export function BotGroupList({ groups, previews, activeRef, onOpen, now }: BotGroupListProps) {
  const { t } = useLocale()
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set())

  const toggle = (key: string): void => {
    setFolded((current) => {
      const next = new Set(current)
      if (!next.delete(key)) next.add(key)
      return next
    })
  }

  return (
    <View style={{ gap: 6 }}>
      {groups.map((group) => {
        const open = !folded.has(group.key)
        return (
          <View key={group.key || "none"} style={{ gap: 2 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t(open ? "shell.collapseGroup" : "shell.expandGroup", {
                project: group.title,
              })}
              aria-expanded={open}
              onPress={() => toggle(group.key)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                paddingHorizontal: 12,
                paddingVertical: 12,
              }}
            >
              <Text style={{ flex: 1, color: tokens.color.text, fontSize: 16, fontWeight: "700" }}>
                {group.title}
              </Text>
              <Text style={{ color: tokens.color.textSecondary, fontSize: 15 }}>{group.bots.length}</Text>
              <Icon name={open ? "chevronUp" : "chevronRight"} size={16} color={tokens.color.textSecondary} />
            </Pressable>
            {open
              ? group.bots.map((bot) => (
                  <BotRow
                    key={bot.id}
                    bot={bot}
                    preview={previews[bot.id]}
                    active={isBotRef(bot, activeRef)}
                    onPress={onOpen}
                    {...(now === undefined ? {} : { now })}
                  />
                ))
              : null}
          </View>
        )
      })}
    </View>
  )
}
