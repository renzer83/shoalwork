import { PodsScreen } from "@shoalwork/ui"
import { useRouter } from "expo-router"

export default function Pods() {
  const router = useRouter()
  return <PodsScreen onOpenPod={(id) => router.push(`/pods/${id}`)} />
}
