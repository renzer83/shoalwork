import { Appbar, Button } from "react-native-paper"
import { useLocale } from "../i18n/index.js"

export interface AppBarProps {
  readonly title: string
  readonly onRefresh?: () => void
}

// Text actions only: the icon font is not bundled yet.
export function AppBar({ title, onRefresh }: AppBarProps) {
  const { t } = useLocale()
  return (
    <Appbar.Header>
      <Appbar.Content title={title} />
      {onRefresh === undefined ? null : <Button onPress={onRefresh}>{t("common.refresh")}</Button>}
    </Appbar.Header>
  )
}
