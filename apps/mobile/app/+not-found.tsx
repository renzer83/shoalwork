import { EmptyState, useLocale } from "@shoalwork/ui"
import { Link } from "expo-router"
import { View } from "react-native"

export default function NotFound() {
  const { t } = useLocale()
  return (
    <View style={{ flex: 1, justifyContent: "center" }}>
      <EmptyState title={t("notFound.title")} hint={t("notFound.hint")} />
      <Link href="/" style={{ textAlign: "center" }}>
        {t("notFound.back")}
      </Link>
    </View>
  )
}
