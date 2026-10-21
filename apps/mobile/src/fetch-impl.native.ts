import { fetch as expoFetch } from "expo/fetch"

// React Native's own fetch has no streaming body, which the live feed needs; expo/fetch does.
export const platformFetch: typeof fetch | undefined = (input, init) => expoFetch(input, init)
