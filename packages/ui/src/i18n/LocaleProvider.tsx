import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react"
import { defaultStore, type KeyValueStore } from "../storage.js"
import {
  detectLocale,
  isLocale,
  LOCALE_KEY,
  type Locale,
  LocaleContext,
  type LocaleState,
  localeStateFor,
} from "./locale.js"

export interface LocaleProviderProps {
  readonly children: ReactNode
  readonly store?: KeyValueStore
  // Fixes the locale and skips storage (tests, a shell that decides). Without it the saved choice wins over the system.
  readonly locale?: Locale
}

export function LocaleProvider({ children, store, locale: forced }: LocaleProviderProps) {
  const kv = useMemo(() => store ?? defaultStore(), [store])
  const [chosen, setChosen] = useState<Locale>(() => detectLocale())

  useEffect(() => {
    if (forced !== undefined) return
    let cancelled = false
    void kv
      .get(LOCALE_KEY)
      .then((saved) => {
        if (!cancelled && isLocale(saved)) setChosen(saved)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [kv, forced])

  const setLocale = useCallback(
    async (next: Locale) => {
      setChosen(next)
      await kv.set(LOCALE_KEY, next)
    },
    [kv],
  )

  const locale = forced ?? chosen
  const value = useMemo<LocaleState>(() => localeStateFor(locale, setLocale), [locale, setLocale])
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}
