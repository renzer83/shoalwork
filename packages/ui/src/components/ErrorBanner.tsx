import { View } from "react-native"
import { Button, Text, useTheme } from "react-native-paper"
import { useLocale } from "../i18n/index.js"

export interface ErrorBannerProps {
  readonly message: string
  readonly onRetry?: () => void
}

export function ErrorBanner({ message, onRetry }: ErrorBannerProps) {
  const theme = useTheme()
  const { t } = useLocale()
  return (
    <View
      accessibilityRole="alert"
      style={{ backgroundColor: theme.colors.errorContainer, borderRadius: 8, padding: 12, gap: 8 }}
    >
      <Text style={{ color: theme.colors.onErrorContainer }}>{message}</Text>
      {onRetry === undefined ? null : <Button onPress={onRetry}>{t("common.retry")}</Button>}
    </View>
  )
}
