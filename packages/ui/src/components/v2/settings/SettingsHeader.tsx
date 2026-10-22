import { Text, View } from "react-native"
import { useLocale } from "../../../i18n/index.js"
import { tokens } from "../../../theme.js"
import { IconButton } from "../IconButton.js"
import { PrimaryButton } from "../PrimaryButton.js"
import { ExecutorIcon } from "./ExecutorIcon.js"
import type { ExecutorFamily } from "./executor-catalog.js"

export interface SettingsHeaderProps {
  // The family of the selected executor: its mark leads the header.
  readonly family: ExecutorFamily
  readonly dirty: boolean
  readonly saving: boolean
  readonly onSave: () => void
  // Phones only: back to the Bot list.
  readonly onBack?: (() => void) | undefined
}

// The title block: mark of the selected executor, "Configuração", its subtitle, and the blue save button.
export function SettingsHeader({ family, dirty, saving, onSave, onBack }: SettingsHeaderProps) {
  const { t } = useLocale()
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 16, padding: 20, paddingBottom: 12 }}>
      {onBack === undefined ? null : (
        <IconButton icon="chevronLeft" label={t("settings.back")} onPress={onBack} />
      )}
      <ExecutorIcon family={family} size={64} />
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <Text
          accessibilityRole="header"
          style={{ color: tokens.color.text, fontSize: 28, fontWeight: "700" }}
        >
          {t("settings.title")}
        </Text>
        <Text style={{ color: tokens.color.textSecondary, fontSize: 15 }}>{t("settings.subtitle")}</Text>
      </View>
      <PrimaryButton
        label={t("settings.save")}
        hint={t("settings.saveHint")}
        disabled={!dirty || saving}
        onPress={onSave}
      />
    </View>
  )
}
