import { HealthScreen } from "@shoalwork/ui"
import { useRouter } from "expo-router"

export default function Health() {
  const router = useRouter()
  return <HealthScreen onOpenSetup={() => router.push("/setup")} />
}
