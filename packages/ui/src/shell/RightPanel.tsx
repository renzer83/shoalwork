import type { ReactNode } from "react"
import { ScrollView, Text, View } from "react-native"
import { IconButton } from "../components/v2/IconButton.js"
import { useLocale } from "../i18n/index.js"
import { tokens } from "../theme.js"

export interface RightPanelProps {
  readonly width: number
  readonly title: string
  readonly onClose: () => void
  readonly children: ReactNode
}

// The column on the right: a tab-like title, a close button and a scrolling body of sections.
export function RightPanel({ width, title, onClose, children }: RightPanelProps) {
  const { t } = useLocale()
  return (
    <View
      accessibilityLabel={title}
      style={{
        width,
        borderLeftWidth: 1,
        borderLeftColor: tokens.color.border,
        backgroundColor: tokens.color.background,
      }}
    >
      <View
        style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 14 }}
      >
        <View
          style={{
            paddingHorizontal: 12,
            paddingVertical: 6,
            borderRadius: tokens.radius.chip,
            backgroundColor: tokens.color.surface,
          }}
        >
          <Text style={{ color: tokens.color.textSecondary, fontSize: 14 }}>{title}</Text>
        </View>
        <IconButton
          icon="close"
          label={t("conv.panel.close")}
          onPress={onClose}
          size={36}
          color={tokens.color.textSecondary}
        />
      </View>
      <ScrollView contentContainerStyle={{ padding: 14, paddingTop: 0, gap: 14 }}>{children}</ScrollView>
    </View>
  )
}
