import { ConnectorScreen } from "@shoalwork/ui"
import { useLocalSearchParams } from "expo-router"

export default function ConnectorRoute() {
  const { id } = useLocalSearchParams<{ id: string }>()
  return <ConnectorScreen id={id} />
}
