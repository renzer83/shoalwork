import { SetupScreen } from "@shoalwork/ui"
import { useRouter } from "expo-router"

// Placeholder until the Configuração screen: the core address and token already live in Setup.
export default function Settings() {
  const router = useRouter()
  return <SetupScreen onDone={() => router.replace("/chat/lead")} />
}
