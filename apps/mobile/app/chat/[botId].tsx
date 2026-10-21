import { ChatScreen } from "@shoalwork/ui"
import { useLocalSearchParams, useRouter } from "expo-router"

export default function ChatRoute() {
  const { botId } = useLocalSearchParams<{ botId: string }>()
  const router = useRouter()
  // A Bot id or a name; the route is also reached as /chat/lead.
  return <ChatScreen bot={botId ?? "lead"} onBack={() => router.replace("/")} />
}
