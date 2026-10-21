import { ApiClient } from "@shoalwork/api-client"
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react"
import { defaultStore, type KeyValueStore } from "./storage.js"

export interface ApiConfig {
  readonly baseUrl: string
  readonly token: string | null
}

interface ApiState {
  readonly client: ApiClient
  readonly config: ApiConfig
  // False until the saved base URL and token were read from storage.
  readonly ready: boolean
  // True when the user saved a base URL in Setup, or the shell/environment provided one (not the built-in default).
  readonly configured: boolean
  readonly save: (config: ApiConfig) => Promise<void>
}

const BASE_URL_KEY = "shoalwork.baseUrl"
const TOKEN_KEY = "shoalwork.token"

// The Electron preload exposes `window.shoalwork = { platform, appUrl, setCoreUrl }`; plain globals read, nothing assumed.
const desktopBridge = (): object | undefined => {
  const bridge: unknown = Reflect.get(globalThis, "shoalwork")
  return typeof bridge === "object" && bridge !== null ? bridge : undefined
}

const desktopAppUrl = (): string | undefined => {
  const bridge = desktopBridge()
  const appUrl: unknown = bridge === undefined ? undefined : Reflect.get(bridge, "appUrl")
  return typeof appUrl === "string" && appUrl !== "" ? appUrl : undefined
}

// Tells the desktop shell which core was saved, so its CSP and CORS allow it. True when the shell took it and the
// page must reload to get a CSP that includes the new origin.
const registerCoreUrl = async (url: string): Promise<boolean> => {
  const bridge = desktopBridge()
  const register: unknown = bridge === undefined ? undefined : Reflect.get(bridge, "setCoreUrl")
  if (typeof register !== "function") {
    return false
  }
  const accepted: unknown = await register(url)
  return accepted === true
}

// A fresh document load is what applies the new CSP; going to the home route keeps Setup from reloading itself.
const reloadPage = (): void => {
  const location: unknown = Reflect.get(globalThis, "location")
  const assign: unknown =
    typeof location === "object" && location !== null ? Reflect.get(location, "assign") : undefined
  if (typeof assign === "function") {
    assign.call(location, "/")
  }
}

// Desktop bridge first (APP_URL of the shell), then EXPO_PUBLIC_APP_URL (inlined into the export at build time).
export const explicitBaseUrl = (): string | undefined => desktopAppUrl() ?? process.env.EXPO_PUBLIC_APP_URL

// Explicit URL, else the core's default port.
export const defaultBaseUrl = (): string => explicitBaseUrl() ?? "http://127.0.0.1:28900"

const ApiContext = createContext<ApiState | null>(null)

export interface ApiProviderProps {
  readonly children: ReactNode
  readonly store?: KeyValueStore
  // Native apps pass expo/fetch here so SSE bodies stream; the web uses the browser fetch.
  readonly fetchImpl?: typeof fetch
}

export function ApiProvider({ children, store, fetchImpl }: ApiProviderProps) {
  const kv = useMemo(() => store ?? defaultStore(), [store])
  const [config, setConfig] = useState<ApiConfig>({ baseUrl: defaultBaseUrl(), token: null })
  const [configured, setConfigured] = useState(explicitBaseUrl() !== undefined)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    void Promise.all([kv.get(BASE_URL_KEY), kv.get(TOKEN_KEY)])
      .then(([baseUrl, token]) => {
        if (!cancelled) {
          setConfig({ baseUrl: baseUrl ?? defaultBaseUrl(), token })
          setConfigured(baseUrl !== null || explicitBaseUrl() !== undefined)
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) {
          setReady(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [kv])

  const save = useCallback(
    async (next: ApiConfig) => {
      await kv.set(BASE_URL_KEY, next.baseUrl)
      if (next.token === null || next.token === "") {
        await kv.remove(TOKEN_KEY)
      } else {
        await kv.set(TOKEN_KEY, next.token)
      }
      setConfig({ baseUrl: next.baseUrl, token: next.token === "" ? null : next.token })
      setConfigured(true)
      if (await registerCoreUrl(next.baseUrl)) {
        reloadPage()
      }
    },
    [kv],
  )

  const value = useMemo<ApiState>(() => {
    const getToken = async () => config.token
    const client =
      fetchImpl === undefined
        ? new ApiClient(config.baseUrl, getToken)
        : new ApiClient(config.baseUrl, getToken, fetchImpl)
    return { client, config, ready, configured, save }
  }, [config, ready, configured, save, fetchImpl])

  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>
}

export const useApi = (): ApiState => {
  const state = useContext(ApiContext)
  if (state === null) {
    throw new Error("useApi must be used inside ApiProvider")
  }
  return state
}

// Test seam: a fixed client without storage.
export function StaticApiProvider({
  client,
  configured = true,
  children,
}: {
  readonly client: ApiClient
  readonly configured?: boolean
  readonly children: ReactNode
}) {
  const value = useMemo<ApiState>(
    () => ({
      client,
      config: { baseUrl: client.baseUrl, token: null },
      ready: true,
      configured,
      save: async () => undefined,
    }),
    [client, configured],
  )
  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>
}
