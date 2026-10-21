import type { TimelineItem } from "@shoalwork/contracts"
import { useState } from "react"
import { Linking, View } from "react-native"
import { Button, Card, Text } from "react-native-paper"
import { type MessageKey, useLocale } from "../../i18n/index.js"

type ArtifactItem = Extract<TimelineItem, { readonly kind: "artifact" }>

// Only http(s) links are ever opened; anything else (javascript:, file:, custom schemes) is shown as text.
export const isWebLink = (ref: string): boolean => {
  try {
    const url = new URL(ref)
    return url.protocol === "https:" || url.protocol === "http:"
  } catch {
    return false
  }
}

const TITLES: Record<ArtifactItem["artifactKind"], MessageKey> = {
  pr: "artifact.pr",
  url: "artifact.url",
  file: "artifact.file",
  text: "artifact.text",
}

export interface ArtifactCardProps {
  readonly item: ArtifactItem
  // Test seam; defaults to the platform's link opener.
  readonly open?: (url: string) => Promise<unknown>
}

export function ArtifactCard({ item, open = (url) => Linking.openURL(url) }: ArtifactCardProps) {
  const [confirming, setConfirming] = useState(false)
  const { t } = useLocale()
  const linkable = (item.artifactKind === "pr" || item.artifactKind === "url") && isWebLink(item.ref)
  return (
    <Card mode="outlined" accessibilityLabel={t(TITLES[item.artifactKind])}>
      <Card.Content style={{ gap: 6 }}>
        <Text variant="titleSmall">{t(TITLES[item.artifactKind])}</Text>
        {item.summary === undefined ? null : <Text>{item.summary}</Text>}
        <Text
          selectable
          style={{ fontFamily: item.artifactKind === "text" ? undefined : "monospace", fontSize: 14 }}
        >
          {item.ref}
        </Text>
        {linkable ? (
          confirming ? (
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Button
                mode="contained"
                accessibilityLabel={t("artifact.confirmOpen")}
                onPress={() => {
                  setConfirming(false)
                  void open(item.ref)
                }}
              >
                {t("artifact.openBrowser")}
              </Button>
              <Button accessibilityLabel={t("common.cancel")} onPress={() => setConfirming(false)}>
                {t("common.cancel")}
              </Button>
            </View>
          ) : (
            <Button accessibilityLabel={t("artifact.open")} onPress={() => setConfirming(true)}>
              {t("artifact.open")}
            </Button>
          )
        ) : null}
      </Card.Content>
    </Card>
  )
}
