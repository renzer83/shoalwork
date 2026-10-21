import { ProjectsScreen } from "@shoalwork/ui"
import { useRouter } from "expo-router"

export default function Projects() {
  const router = useRouter()
  return <ProjectsScreen onOpenProject={(slug) => router.push(`/projects/${slug}`)} />
}
