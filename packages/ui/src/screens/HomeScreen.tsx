import { Effect } from "effect"
import { useEffect, useRef } from "react"
import { View } from "react-native"
import { ActivityIndicator, Text, useTheme } from "react-native-paper"
import { useApi } from "../api-context.js"

export type HomeRoute = "/chat" | "/health" | "/setup"

export interface HomeScreenProps {
  readonly onRoute: (href: HomeRoute) => void
}

// Decides where "/" goes: Conversa when the core answers; otherwise Setup when no base URL was ever configured,
// or Health (which shows why the core is unreachable) when one was.
export function HomeScreen({ onRoute }: HomeScreenProps) {
  const { client, configured, ready } = useApi()
  const theme = useTheme()
  // Kept in a ref so a new callback identity from the parent does not re-run the probe.
  const routeRef = useRef(onRoute)
  routeRef.current = onRoute

  useEffect(() => {
    if (!ready) {
      return
    }
    let cancelled = false
    void Effect.runPromise(Effect.result(client.health())).then((result) => {
      if (cancelled) {
        return
      }
      if (result._tag === "Success") {
        routeRef.current("/chat")
      } else {
        routeRef.current(configured ? "/health" : "/setup")
      }
    })
    return () => {
      cancelled = true
    }
  }, [ready, client, configured])

  return (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: theme.colors.background,
      }}
    >
      <ActivityIndicator accessibilityLabel="Checking the core" />
      <Text variant="bodySmall" style={{ marginTop: 12 }}>
        Checking the core
      </Text>
    </View>
  )
}
