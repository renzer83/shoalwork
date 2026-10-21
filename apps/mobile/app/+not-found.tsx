import { EmptyState } from "@shoalwork/ui"
import { Link } from "expo-router"
import { View } from "react-native"

export default function NotFound() {
  return (
    <View style={{ flex: 1, justifyContent: "center" }}>
      <EmptyState title="Page not found" hint="This route does not exist." />
      <Link href="/" style={{ textAlign: "center" }}>
        Back to health
      </Link>
    </View>
  )
}
