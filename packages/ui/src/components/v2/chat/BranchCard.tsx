import { Text, View } from "react-native"
import { useLocale } from "../../../i18n/index.js"
import { tokens } from "../../../theme.js"
import { Icon } from "../Icon.js"
import { PrimaryButton } from "../PrimaryButton.js"

export interface BranchCardProps {
  readonly branch: string
  readonly filesChanged: number
  readonly added: number
  readonly removed: number
  readonly onViewFiles?: () => void
}

// A branch with its diff summary: orange git mark, name, files changed, +added -removed.
export function BranchCard({ branch, filesChanged, added, removed, onViewFiles }: BranchCardProps) {
  const { t } = useLocale()
  return (
    <View
      accessibilityLabel={t("conv.branch.label", { branch })}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        backgroundColor: tokens.color.background,
        borderRadius: tokens.radius.button,
        padding: 10,
      }}
    >
      <View
        style={{
          width: 44,
          height: 44,
          borderRadius: tokens.radius.button,
          backgroundColor: tokens.color.elevated,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon name="branch" color={tokens.color.orange} size={26} />
      </View>
      <View style={{ flex: 1 }}>
        <Text
          numberOfLines={1}
          style={{ color: tokens.color.text, fontSize: tokens.font.size, fontFamily: tokens.font.mono }}
        >
          {branch}
        </Text>
        <Text style={{ color: tokens.color.textSecondary, fontSize: 14 }}>
          {t(filesChanged === 1 ? "conv.branch.file" : "conv.branch.files", { count: filesChanged })}
        </Text>
      </View>
      <Text style={{ color: tokens.color.green, fontSize: 15 }}>{`+${added}`}</Text>
      <Text style={{ color: tokens.color.red, fontSize: 15 }}>{`−${removed}`}</Text>
      {onViewFiles === undefined ? null : (
        <PrimaryButton label={t("conv.branch.view")} variant="secondary" onPress={onViewFiles} />
      )}
    </View>
  )
}
