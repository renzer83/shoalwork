import { Pressable, Text, View } from "react-native"
import { useLocale } from "../../../i18n/index.js"
import { tokens } from "../../../theme.js"
import { Avatar } from "../Avatar.js"
import { Chip } from "../Chip.js"
import { Icon } from "../Icon.js"
import { IconButton } from "../IconButton.js"
import { StatusLabel } from "../StatusDot.js"

export interface ChatHeaderProps {
  readonly botId: string
  readonly name: string
  readonly status: { readonly color: string; readonly label: string }
  readonly project?: string | undefined
  readonly executor?: string | undefined
  readonly model?: string | undefined
  // Chevron next to the name: switch to another Bot.
  readonly onSwitch?: (() => void) | undefined
  // Back to the Bot list (narrow windows only).
  readonly onBack?: (() => void) | undefined
  readonly onTogglePanel?: (() => void) | undefined
}

export function ChatHeader({
  botId,
  name,
  status,
  project,
  executor,
  model,
  onSwitch,
  onBack,
  onTogglePanel,
}: ChatHeaderProps) {
  const { t } = useLocale()
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 14,
        paddingHorizontal: 18,
        paddingVertical: 14,
        borderBottomWidth: 1,
        borderBottomColor: tokens.color.border,
      }}
    >
      {onBack === undefined ? null : (
        <IconButton icon="chevronLeft" label={t("common.back")} onPress={onBack} />
      )}
      <Avatar id={botId} size={48} />
      <View style={{ flex: 1, gap: 6 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("conv.header.switch")}
          disabled={onSwitch === undefined}
          onPress={onSwitch}
          style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
        >
          <Text numberOfLines={1} style={{ color: tokens.color.text, fontSize: 22, fontWeight: "700" }}>
            {name}
          </Text>
          <Icon name="chevronDown" size={18} color={tokens.color.textSecondary} />
        </Pressable>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <StatusLabel color={status.color} label={status.label} size={15} />
          {project === undefined ? null : (
            <Chip
              label={project}
              icon={<Icon name="folder" size={14} color={tokens.color.textSecondary} />}
            />
          )}
          {executor === undefined ? null : (
            <Chip
              label={executor}
              mono
              icon={<Icon name="sparkle" size={14} color={tokens.color.textSecondary} />}
            />
          )}
          {model === undefined ? null : <Chip label={model} mono />}
        </View>
      </View>
      {onTogglePanel === undefined ? null : (
        <IconButton
          icon="more"
          label={t("conv.header.panel")}
          onPress={onTogglePanel}
          background={tokens.color.surface}
        />
      )}
    </View>
  )
}
