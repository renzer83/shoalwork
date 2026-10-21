import type { TimelineItem } from "@shoalwork/contracts"
import { useState } from "react"
import { Linking, View } from "react-native"
import { Button, Card, Text } from "react-native-paper"

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

const TITLES: Record<ArtifactItem["artifactKind"], string> = {
  pr: "Pull request",
  url: "Link",
  file: "File",
  text: "Note",
}

export interface ArtifactCardProps {
  readonly item: ArtifactItem
  // Test seam; defaults to the platform's link opener.
  readonly open?: (url: string) => Promise<unknown>
}

export function ArtifactCard({ item, open = (url) => Linking.openURL(url) }: ArtifactCardProps) {
  const [confirming, setConfirming] = useState(false)
  const linkable = (item.artifactKind === "pr" || item.artifactKind === "url") && isWebLink(item.ref)
  return (
    <Card mode="outlined" accessibilityLabel={TITLES[item.artifactKind]}>
      <Card.Content style={{ gap: 6 }}>
        <Text variant="titleSmall">{TITLES[item.artifactKind]}</Text>
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
                accessibilityLabel="Confirm open link"
                onPress={() => {
                  setConfirming(false)
                  void open(item.ref)
                }}
              >
                Open in browser
              </Button>
              <Button accessibilityLabel="Cancel" onPress={() => setConfirming(false)}>
                Cancel
              </Button>
            </View>
          ) : (
            <Button accessibilityLabel="Open link" onPress={() => setConfirming(true)}>
              Open link
            </Button>
          )
        ) : null}
      </Card.Content>
    </Card>
  )
}
