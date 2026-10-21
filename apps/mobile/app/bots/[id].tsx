import { BotScreen } from "@shoalwork/ui"
import { useLocalSearchParams } from "expo-router"

export default function BotRoute() {
  const { id } = useLocalSearchParams<{ id: string }>()
  return <BotScreen idOrName={id} />
}
