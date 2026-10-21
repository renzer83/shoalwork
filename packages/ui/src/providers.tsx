import type { ReactNode } from "react"
import { PaperProvider } from "react-native-paper"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { ApiProvider } from "./api-context.js"
import { LocaleProvider } from "./i18n/LocaleProvider.js"
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
        <LocaleProvider {...(store === undefined ? {} : { store })}>
          <ApiProvider
            {...(store === undefined ? {} : { store })}
            {...(fetchImpl === undefined ? {} : { fetchImpl })}
          >
            {children}
          </ApiProvider>
        </LocaleProvider>
      </PaperProvider>
    </SafeAreaProvider>
  )
}
