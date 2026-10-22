import { Text, View } from "react-native"
import { useLocale } from "../../../i18n/index.js"
import { tokens } from "../../../theme.js"
import { serviceIcon } from "../chat/LinkCard.js"
import { hostOf, LinkAction } from "../chat/open-link.js"
import { Icon } from "../Icon.js"
import { PanelSection } from "./AboutBot.js"

export interface UsefulLinksProps {
  readonly urls: ReadonlyArray<string>
  readonly open?: (url: string) => Promise<unknown>
}

export function UsefulLinks({ urls, open }: UsefulLinksProps) {
  const { t } = useLocale()
  return (
    <PanelSection title={t("conv.links.title")}>
      {urls.length === 0 ? (
        <Text style={{ color: tokens.color.textSecondary, fontSize: 14 }}>{t("conv.links.empty")}</Text>
      ) : (
        urls.map((url) => (
          <View key={url} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8 }}>
            <Icon name={serviceIcon(hostOf(url))} size={20} color={tokens.color.text} />
            <Text numberOfLines={1} style={{ flex: 1, color: tokens.color.text, fontSize: 15 }}>
              {hostOf(url)}
            </Text>
            <LinkAction
              url={url}
              label={t("conv.link.open")}
              variant="text"
              {...(open === undefined ? {} : { open })}
            />
          </View>
        ))
      )}
    </PanelSection>
  )
}
