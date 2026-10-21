import { SetupScreen } from "@shoalwork/ui"
import { useRouter } from "expo-router"

export default function Setup() {
  const router = useRouter()
  return <SetupScreen onDone={() => router.replace("/")} />
}
