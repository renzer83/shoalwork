import { HealthScreen } from "@shoalwork/ui"
import { useRouter } from "expo-router"

export default function Index() {
  const router = useRouter()
  return <HealthScreen onOpenSetup={() => router.push("/setup")} />
}
