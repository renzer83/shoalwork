import { ConversationScreen } from "@shoalwork/ui"
import { useLocalSearchParams } from "expo-router"

export default function ChatRoute() {
  const { botId } = useLocalSearchParams<{ botId: string }>()
  // A Bot id or a name; the route is also reached as /chat/lead. The sidebar is always visible, so no Back button.
  return <ConversationScreen key={botId} bot={botId ?? "lead"} />
}
