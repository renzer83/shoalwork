import { useState } from "react"
import { Linking, Pressable, Text, View } from "react-native"
import { useLocale } from "../../../i18n/index.js"
import { tokens } from "../../../theme.js"
import { PrimaryButton } from "../PrimaryButton.js"

const WEB_SCHEME = /^https?:\/\//

// Only plain http(s) links are ever opened: the text must start with a lowercase http:// or https:// and carry no
// credentials. Anything else (javascript:, file:, mailto:, HTTP://, user:pass@host) is shown as text.
export const isWebUrl = (ref: string): boolean => {
  if (!WEB_SCHEME.test(ref)) return false
  try {
    const url = new URL(ref)
    return (
      (url.protocol === "https:" || url.protocol === "http:") && url.username === "" && url.password === ""
    )
  } catch {
    return false
  }
}

export const hostOf = (ref: string): string => {
  try {
    return new URL(ref).hostname.replace(/^www\./, "")
  } catch {
    return ref
  }
}

// The domain itself or one of its subdomains: "gist.github.com" is GitHub, "notgithub.com" is not.
export const isHostOf = (host: string, domain: string): boolean =>
  host === domain || host.endsWith(`.${domain}`)

export interface LinkActionProps {
  readonly url: string
  readonly label: string
  // Test seam; defaults to the platform's link opener.
  readonly open?: (url: string) => Promise<unknown>
  readonly variant?: "button" | "text"
}

// A button that opens a web link after one confirmation. A link that is not http(s) renders nothing.
export function LinkAction({
  url,
  label,
  open = (target) => Linking.openURL(target),
  variant = "button",
}: LinkActionProps) {
  const { t } = useLocale()
  const [confirming, setConfirming] = useState(false)
  if (!isWebUrl(url)) return null
  if (confirming) {
    return (
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <PrimaryButton
          label={t("conv.link.confirm", { host: hostOf(url) })}
          onPress={() => {
            setConfirming(false)
            void open(url)
          }}
        />
        <PrimaryButton label={t("common.cancel")} variant="secondary" onPress={() => setConfirming(false)} />
      </View>
    )
  }
  if (variant === "text") {
    return (
      <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={() => setConfirming(true)}>
        <Text style={{ color: tokens.color.link, fontSize: tokens.font.size, fontWeight: "600" }}>
          {label}
        </Text>
      </Pressable>
    )
  }
  return <PrimaryButton label={label} variant="secondary" onPress={() => setConfirming(true)} />
}
