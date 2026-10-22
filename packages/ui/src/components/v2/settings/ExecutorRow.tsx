import { Pressable, Text, View } from "react-native"
import { useLocale } from "../../../i18n/index.js"
import { tokens } from "../../../theme.js"
import { IconButton } from "../IconButton.js"
import { ConnectionStatus } from "./ConnectionStatus.js"
import { Dropdown } from "./Dropdown.js"
import { ExecutorIcon } from "./ExecutorIcon.js"
import { familyOf } from "./executor-catalog.js"
import { ModelChips } from "./ModelChips.js"
import type { ExecutorSetting } from "./settings-model.js"
import { Toggle } from "./Toggle.js"

export interface ExecutorRowProps {
  readonly setting: ExecutorSetting
  // How many executors there are: the priorities offered are 1..count.
  readonly count: number
  readonly selected: boolean
  readonly onSelect: (id: string) => void
  readonly onToggle: (id: string, enabled: boolean) => void
  readonly onPriority: (id: string, priority: number) => void
  readonly onModel: (id: string, model: string) => void
}

// One executor: mark, name and connection state, the on/off switch, the `Padrão` chip, the priority, and its models.
export function ExecutorRow({
  setting,
  count,
  selected,
  onSelect,
  onToggle,
  onPriority,
  onModel,
}: ExecutorRowProps) {
  const { t } = useLocale()
  const priorities = Array.from({ length: count }, (_, index) => ({
    value: String(index + 1),
    label: t("settings.row.priority", { n: index + 1 }),
  }))
  return (
    <View
      accessibilityLabel={setting.name}
      style={{
        gap: 12,
        padding: 14,
        borderBottomWidth: 1,
        borderBottomColor: tokens.color.border,
        backgroundColor: selected ? tokens.color.accentSoft : "transparent",
        zIndex: count - setting.priority + 1,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("settings.row.open", { name: setting.name })}
          accessibilityState={{ selected }}
          onPress={() => onSelect(setting.id)}
          style={{ flexDirection: "row", alignItems: "center", gap: 14, flex: 1, minWidth: 200 }}
        >
          <ExecutorIcon family={familyOf(setting.id)} />
          <View style={{ gap: 4 }}>
            <Text style={{ color: tokens.color.text, fontSize: 18, fontWeight: "600" }}>{setting.name}</Text>
            <ConnectionStatus connected={setting.connected} />
          </View>
        </Pressable>
        <Toggle
          value={setting.enabled}
          onChange={(enabled) => onToggle(setting.id, enabled)}
          label={t("settings.row.enable", { name: setting.name })}
        />
        <View style={{ width: 96, alignItems: "center" }}>
          {setting.isDefault ? (
            <View
              style={{
                paddingHorizontal: 16,
                paddingVertical: 6,
                borderRadius: tokens.radius.chip,
                backgroundColor: tokens.color.purple,
              }}
            >
              <Text style={{ color: tokens.color.white, fontSize: 14, fontWeight: "700" }}>
                {t("settings.row.default")}
              </Text>
            </View>
          ) : null}
        </View>
        <Dropdown
          value={String(setting.priority)}
          options={priorities}
          onChange={(value) => onPriority(setting.id, Number(value))}
          label={t("settings.row.priorityLabel", { name: setting.name })}
          width={130}
        />
        <IconButton
          icon="more"
          label={t("settings.row.more", { name: setting.name })}
          onPress={() => onSelect(setting.id)}
          size={36}
          color={tokens.color.textSecondary}
        />
      </View>
      {setting.models.length === 0 ? null : (
        <View style={{ paddingLeft: 62 }}>
          <ModelChips
            models={setting.models}
            main={setting.mainModel}
            onSelect={(model) => onModel(setting.id, model)}
            disabled={!setting.enabled}
          />
        </View>
      )}
    </View>
  )
}
