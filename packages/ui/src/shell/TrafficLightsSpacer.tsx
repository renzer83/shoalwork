import { View } from "react-native"

export const TRAFFIC_LIGHTS_WIDTH = 78

// The macOS window buttons sit inside the sidebar header when the desktop shell hides its title bar and says so
// (`window.shoalwork.titleBarInset`). Everywhere else there is nothing to leave room for.
export const hasInsetTitleBar = (): boolean => {
  const bridge: unknown = Reflect.get(globalThis, "shoalwork")
  return typeof bridge === "object" && bridge !== null && Reflect.get(bridge, "titleBarInset") === true
}

export function TrafficLightsSpacer() {
  return hasInsetTitleBar() ? <View style={{ width: TRAFFIC_LIGHTS_WIDTH }} /> : null
}
