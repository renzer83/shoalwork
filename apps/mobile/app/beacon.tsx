import { BeaconScreen } from "@shoalwork/ui"
import { useRouter } from "expo-router"

export default function Beacon() {
  const router = useRouter()
  return <BeaconScreen onOpenBot={(botId) => router.push(`/bots/${botId}`)} />
}
