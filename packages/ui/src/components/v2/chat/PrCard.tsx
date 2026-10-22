import { Text, View } from "react-native"
import { useLocale } from "../../../i18n/index.js"
import { tokens } from "../../../theme.js"
import { Icon } from "../Icon.js"
import { StatusLabel } from "../StatusDot.js"
import { hostOf, isHostOf, LinkAction } from "./open-link.js"

export type PrState = "open" | "merged" | "closed"

export interface PrCardProps {
  readonly url: string
  readonly title: string
  readonly number?: number | undefined
  // "feature/x → main", when the core knows both sides.
  readonly route?: string | undefined
  readonly state?: PrState | undefined
  readonly open?: (url: string) => Promise<unknown>
}

// "https://github.com/o/r/pull/482" -> 482. Only GitHub urls have this shape, so any other host gives nothing.
export const prNumberOf = (url: string): number | undefined => {
  if (!isHostOf(hostOf(url), "github.com")) return undefined
  const match = /\/pull\/(\d+)/.exec(url)
  return match?.[1] === undefined ? undefined : Number(match[1])
}

const STATE_COLOR: Readonly<Record<PrState, string>> = {
  open: tokens.color.green,
  merged: tokens.color.purple,
  closed: tokens.color.red,
}

export function PrCard({ url, title, number, route, state, open }: PrCardProps) {
  const { t } = useLocale()
  const host = hostOf(url)
  const github = isHostOf(host, "github.com")
  return (
    <View
      accessibilityLabel={t("conv.pr.label", { title })}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        backgroundColor: tokens.color.background,
        borderRadius: tokens.radius.button,
        padding: 10,
      }}
    >
      <View style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
        <Icon name={github ? "github" : "branch"} color={tokens.color.text} size={30} />
      </View>
      <View style={{ flex: 1 }}>
        <Text
          numberOfLines={1}
          style={{ color: tokens.color.text, fontSize: tokens.font.size, fontWeight: "600" }}
        >
          {github && number !== undefined ? `#${number}  ${title}` : title}
        </Text>
        <Text
          numberOfLines={1}
          style={{ color: tokens.color.textSecondary, fontSize: 14, fontFamily: tokens.font.mono }}
        >
          {route === undefined ? host : `${route} · ${host}`}
        </Text>
      </View>
      {state === undefined ? null : (
        <View
          style={{
            paddingHorizontal: 10,
            paddingVertical: 6,
            borderRadius: tokens.radius.chip,
            backgroundColor: state === "open" ? tokens.color.greenSoft : tokens.color.elevated,
          }}
        >
          <StatusLabel color={STATE_COLOR[state]} label={t(`conv.pr.${state}`)} />
        </View>
      )}
      <LinkAction url={url} label={t("conv.pr.view")} {...(open === undefined ? {} : { open })} />
    </View>
  )
}
