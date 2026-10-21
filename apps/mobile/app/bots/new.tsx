import { NewBotScreen } from "@shoalwork/ui"
import { useRouter } from "expo-router"

export default function NewBot() {
  const router = useRouter()
  return <NewBotScreen onCreated={(name) => router.replace(`/bots/${name}`)} />
}
