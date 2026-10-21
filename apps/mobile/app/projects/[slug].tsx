import { ProjectBoardScreen } from "@shoalwork/ui"
import { useLocalSearchParams } from "expo-router"

export default function ProjectBoardRoute() {
  const { slug } = useLocalSearchParams<{ slug: string }>()
  return <ProjectBoardScreen slug={slug} />
}
