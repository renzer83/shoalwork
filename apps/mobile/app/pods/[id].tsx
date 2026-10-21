import { PodScreen } from "@shoalwork/ui"
import { useLocalSearchParams } from "expo-router"

export default function PodRoute() {
  const { id } = useLocalSearchParams<{ id: string }>()
  return <PodScreen id={id} />
}
