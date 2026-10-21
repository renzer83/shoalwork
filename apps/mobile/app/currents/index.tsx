import { CurrentsScreen } from "@shoalwork/ui"
import { useRouter } from "expo-router"

export default function Currents() {
  const router = useRouter()
  return <CurrentsScreen onOpenConnector={(id) => router.push(`/currents/${id}`)} />
}
