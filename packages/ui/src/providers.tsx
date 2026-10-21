import type { ReactNode } from "react"
import { PaperProvider } from "react-native-paper"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { ApiProvider } from "./api-context.js"
import type { KeyValueStore } from "./storage.js"
import { useAppTheme } from "./theme.js"

export interface ProvidersProps {
  readonly children: ReactNode
  readonly store?: KeyValueStore
  readonly fetchImpl?: typeof fetch
}

export function Providers({ children, store, fetchImpl }: ProvidersProps) {
  const theme = useAppTheme()
  return (
    <SafeAreaProvider>
      <PaperProvider theme={theme}>
        <ApiProvider
          {...(store === undefined ? {} : { store })}
          {...(fetchImpl === undefined ? {} : { fetchImpl })}
        >
          {children}
        </ApiProvider>
      </PaperProvider>
    </SafeAreaProvider>
  )
}
