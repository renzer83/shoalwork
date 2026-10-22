import { useShell } from "@shoalwork/ui"
import { Redirect } from "expo-router"

// On a wide window /chat opens the Guide; on a phone it is the Bot list, which the shell draws itself.
export default function ChatIndex() {
  const { narrow } = useShell()
  return narrow ? null : <Redirect href="/chat/lead" />
}
