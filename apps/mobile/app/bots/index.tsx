import { BotsScreen } from "@shoalwork/ui"
import { useRouter } from "expo-router"

export default function Bots() {
  const router = useRouter()
  return <BotsScreen onOpenBot={(id) => router.push(`/bots/${id}`)} />
}
