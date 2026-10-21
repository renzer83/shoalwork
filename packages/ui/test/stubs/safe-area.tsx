import type { ReactNode } from "react"

// The real package loads native specs that vitest cannot parse; screens only read zero insets in tests.
const insets = { top: 0, right: 0, bottom: 0, left: 0 }
export const SafeAreaProvider = ({ children }: { children?: ReactNode }) => <>{children}</>
export const SafeAreaInsetsContext = {
  Consumer: ({ children }: { children: (value: typeof insets) => ReactNode }) => <>{children(insets)}</>,
}
export const useSafeAreaInsets = () => insets
export const useSafeAreaFrame = () => ({ x: 0, y: 0, width: 800, height: 600 })
