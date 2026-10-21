import { Providers } from "@shoalwork/ui"
import { Stack } from "expo-router"
import { platformFetch } from "../src/fetch-impl"

export default function RootLayout() {
  return (
    <Providers {...(platformFetch === undefined ? {} : { fetchImpl: platformFetch })}>
      <Stack screenOptions={{ headerShown: false }} />
    </Providers>
  )
}
