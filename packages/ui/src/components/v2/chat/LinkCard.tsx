import { Text, View } from "react-native"
import { useLocale } from "../../../i18n/index.js"
import { tokens } from "../../../theme.js"
import { Icon, type IconName } from "../Icon.js"
import { hostOf, isHostOf, LinkAction } from "./open-link.js"

export interface LinkCardProps {
  readonly url: string
  readonly title?: string | undefined
  readonly open?: (url: string) => Promise<unknown>
}

// The service mark of a host: Figma and GitHub have their own, anything else is a plain link.
export const serviceIcon = (host: string): IconName => {
  if (isHostOf(host, "figma.com")) return "figma"
  if (isHostOf(host, "github.com")) return "github"
  return "link"
}

export function LinkCard({ url, title, open }: LinkCardProps) {
  const { t } = useLocale()
  const host = hostOf(url)
  return (
    <View
      accessibilityLabel={t("conv.link.label", { host })}
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
        <Icon name={serviceIcon(host)} color={tokens.color.text} size={24} />
      </View>
      <View style={{ flex: 1 }}>
        <Text
          numberOfLines={1}
          style={{ color: tokens.color.text, fontSize: tokens.font.size, fontWeight: "600" }}
        >
          {title ?? host}
        </Text>
        <Text numberOfLines={1} style={{ color: tokens.color.textSecondary, fontSize: 14 }}>
          {host}
        </Text>
      </View>
      <LinkAction url={url} label={t("conv.link.open")} {...(open === undefined ? {} : { open })} />
    </View>
  )
}
