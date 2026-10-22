import { Text, View } from "react-native"
import { useLocale } from "../../../i18n/index.js"
import { tokens } from "../../../theme.js"
import { Icon } from "../Icon.js"
import { PanelSection } from "./AboutBot.js"

export interface RecentFilesProps {
  // Paths, newest first.
  readonly files: ReadonlyArray<string>
}

export function RecentFiles({ files }: RecentFilesProps) {
  const { t } = useLocale()
  return (
    <PanelSection title={t("conv.files.title")}>
      {files.length === 0 ? (
        <Text style={{ color: tokens.color.textSecondary, fontSize: 14 }}>{t("conv.files.empty")}</Text>
      ) : (
        files.map((file) => (
          <View
            key={file}
            style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6 }}
          >
            <Icon name="file" size={18} color={tokens.color.textSecondary} />
            <Text
              numberOfLines={1}
              style={{
                flex: 1,
                color: tokens.color.textSecondary,
                fontSize: 14,
                fontFamily: tokens.font.mono,
              }}
            >
              {file}
            </Text>
          </View>
        ))
      )}
    </PanelSection>
  )
}
