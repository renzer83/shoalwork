import { Appbar, Button } from "react-native-paper"

export interface AppBarProps {
  readonly title: string
  readonly onRefresh?: () => void
}

// Text actions only: the icon font is not bundled yet.
export function AppBar({ title, onRefresh }: AppBarProps) {
  return (
    <Appbar.Header>
      <Appbar.Content title={title} />
      {onRefresh === undefined ? null : <Button onPress={onRefresh}>Refresh</Button>}
    </Appbar.Header>
  )
}
