import type { ReactNode } from "react"
import { Text, View } from "react-native"
import { tokens } from "../../../theme.js"
import { Avatar, HumanAvatar } from "../Avatar.js"
import { Icon } from "../Icon.js"

export type Author =
  | { readonly kind: "bot"; readonly id: string; readonly name: string }
  | { readonly kind: "human"; readonly name: string }

export interface MessageBubbleProps {
  readonly author: Author
  readonly time: string
  readonly text: string
  // Cards (branch, link, PR) that belong to the message render under its text, inside the bubble.
  readonly children?: ReactNode
  // The bubble fills the column (it holds cards) instead of wrapping its text.
  readonly wide?: boolean
}

const BULLET = /^\s*[-*•]\s+(.*)$/

// The body is plain data: only lines that start with a bullet marker become list items, nothing else is parsed.
const lines = (
  text: string,
): ReadonlyArray<{ readonly key: string; readonly bullet: boolean; readonly text: string }> =>
  text.split("\n").map((line, index) => {
    const match = BULLET.exec(line)
    return { key: `${index}`, bullet: match !== null, text: match?.[1] ?? line }
  })

export function MessageBubble({ author, time, text, children, wide = false }: MessageBubbleProps) {
  return (
    <View style={{ flexDirection: "row", gap: 12, alignItems: "flex-start" }}>
      {author.kind === "bot" ? (
        <Avatar id={author.id} size={44} />
      ) : (
        <HumanAvatar name={author.name} size={44} />
      )}
      <View style={{ flex: 1, gap: 6 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Text style={{ color: tokens.color.text, fontSize: 15, fontWeight: "600" }}>{author.name}</Text>
          <Text style={{ color: tokens.color.textSecondary, fontSize: 14 }}>{time}</Text>
          <View style={{ flex: 1 }} />
          <Icon name="more" size={18} color={tokens.color.textSecondary} />
        </View>
        <View
          testID="message-bubble"
          style={{
            alignSelf: wide ? "stretch" : "flex-start",
            maxWidth: "100%",
            backgroundColor: tokens.color.surface,
            borderRadius: tokens.radius.card,
            paddingHorizontal: 14,
            paddingVertical: 12,
            gap: 8,
          }}
        >
          <View style={{ gap: 4 }}>
            {lines(text).map((line) =>
              line.bullet ? (
                <View key={line.key} style={{ flexDirection: "row", gap: 8, paddingLeft: 8 }}>
                  <Text style={{ color: tokens.color.text, fontSize: tokens.font.size }}>•</Text>
                  <Text
                    selectable
                    style={{ flex: 1, color: tokens.color.text, fontSize: tokens.font.size, lineHeight: 22 }}
                  >
                    {line.text}
                  </Text>
                </View>
              ) : (
                <Text
                  key={line.key}
                  selectable
                  style={{ color: tokens.color.text, fontSize: tokens.font.size, lineHeight: 22 }}
                >
                  {line.text}
                </Text>
              ),
            )}
          </View>
          {children}
        </View>
      </View>
    </View>
  )
}
