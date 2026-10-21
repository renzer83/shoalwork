import { createContext, useContext } from "react"
import { en, type MessageKey } from "./en.js"
import { ptBR } from "./pt-BR.js"

export const LOCALES = ["pt-BR", "en"] as const
export type Locale = (typeof LOCALES)[number]

// Key of the locale saved in the app's key-value storage.
export const LOCALE_KEY = "shoalwork.locale"

// Values for the {name} placeholders of a message.
export type Params = Readonly<Record<string, string | number>>
export type Translate = (key: MessageKey, params?: Params) => string

const TABLES: Readonly<Record<Locale, Readonly<Record<MessageKey, string>>>> = { "pt-BR": ptBR, en }

export const isLocale = (value: unknown): value is Locale => value === "pt-BR" || value === "en"

// Pure: the text of a key in a locale, with its placeholders filled. A placeholder without a value is kept as is.
export const translate = (locale: Locale, key: MessageKey, params: Params = {}): string =>
  TABLES[locale][key].replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    name in params ? String(params[name]) : placeholder,
  )

const systemLanguage = (): string => {
  const nav: unknown = Reflect.get(globalThis, "navigator")
  const language: unknown = typeof nav === "object" && nav !== null ? Reflect.get(nav, "language") : undefined
  return typeof language === "string" ? language : Intl.DateTimeFormat().resolvedOptions().locale
}

// The first run follows the system language: any Portuguese variant is pt-BR, everything else is English.
export const detectLocale = (): Locale => (systemLanguage().toLowerCase().startsWith("pt") ? "pt-BR" : "en")

export interface LocaleState {
  readonly locale: Locale
  readonly t: Translate
  readonly setLocale: (locale: Locale) => Promise<void>
}

export const localeStateFor = (locale: Locale, setLocale: LocaleState["setLocale"]): LocaleState => ({
  locale,
  setLocale,
  t: (key, params) => translate(locale, key, params),
})

export const LocaleContext = createContext<LocaleState | null>(null)

let outside: LocaleState | undefined

// The text of the screens. Outside a LocaleProvider (a bare render) it reads the system language and cannot save a
// change: the same object on every call, so effects that depend on `t` do not re-run on each render.
export const useLocale = (): LocaleState => {
  const state = useContext(LocaleContext)
  if (state !== null) return state
  outside ??= localeStateFor(detectLocale(), async () => undefined)
  return outside
}
