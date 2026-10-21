import { useColorScheme } from "react-native"
import { MD3DarkTheme, MD3LightTheme, type MD3Theme } from "react-native-paper"

export const lightTheme: MD3Theme = {
  ...MD3LightTheme,
  colors: {
    ...MD3LightTheme.colors,
    primary: "#0b6e8a",
    secondary: "#3d5a66",
    error: "#b3261e",
  },
}

export const darkTheme: MD3Theme = {
  ...MD3DarkTheme,
  colors: {
    ...MD3DarkTheme.colors,
    primary: "#6cd0ee",
    secondary: "#a6c4cf",
    error: "#f2b8b5",
  },
}

export const themeFor = (scheme: "light" | "dark" | null | undefined): MD3Theme =>
  scheme === "dark" ? darkTheme : lightTheme

export const useAppTheme = (): MD3Theme => themeFor(useColorScheme())
