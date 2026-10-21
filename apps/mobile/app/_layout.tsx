import { AppNavigation, Providers } from "@shoalwork/ui"
import { Stack, usePathname, useRouter } from "expo-router"
import { platformFetch } from "../src/fetch-impl"

export default function RootLayout() {
  const router = useRouter()
  const pathname = usePathname()
  return (
    <Providers {...(platformFetch === undefined ? {} : { fetchImpl: platformFetch })}>
      <AppNavigation pathname={pathname} onNavigate={(href) => router.navigate(href)}>
        <Stack screenOptions={{ headerShown: false }} />
      </AppNavigation>
    </Providers>
  )
}
