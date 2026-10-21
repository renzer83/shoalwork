import { HomeScreen } from "@shoalwork/ui"
import { useRouter } from "expo-router"

export default function Index() {
  const router = useRouter()
  return <HomeScreen onRoute={(href) => router.replace(href)} />
}
