import * as SecureStore from "expo-secure-store"
import { Platform } from "react-native"

// Native: Keychain/Keystore through expo-secure-store. Web and Electron (the web export): localStorage.
// Values stay small (a base URL and a token), well under the SecureStore limit.
export interface KeyValueStore {
  readonly get: (key: string) => Promise<string | null>
  readonly set: (key: string, value: string) => Promise<void>
  readonly remove: (key: string) => Promise<void>
}

const webStore: KeyValueStore = {
  get: async (key) => globalThis.localStorage?.getItem(key) ?? null,
  set: async (key, value) => {
    globalThis.localStorage?.setItem(key, value)
  },
  remove: async (key) => {
    globalThis.localStorage?.removeItem(key)
  },
}

const nativeStore: KeyValueStore = {
  get: (key) => SecureStore.getItemAsync(key),
  set: (key, value) => SecureStore.setItemAsync(key, value),
  remove: (key) => SecureStore.deleteItemAsync(key),
}

export const defaultStore = (): KeyValueStore => (Platform.OS === "web" ? webStore : nativeStore)
