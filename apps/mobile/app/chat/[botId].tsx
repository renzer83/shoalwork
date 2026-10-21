import { ChatScreen } from "@shoalwork/ui"
import { useLocalSearchParams } from "expo-router"

export default function ChatRoute() {
  const { botId } = useLocalSearchParams<{ botId: string }>()
  // A Bot id or a name; the route is also reached as /chat/lead. The menu is always visible, so no Back button.
  return <ChatScreen bot={botId ?? "lead"} />
}
