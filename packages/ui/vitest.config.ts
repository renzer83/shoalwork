import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

// The screens are React Native; in tests react-native-web renders them in jsdom.
export default defineConfig({
  resolve: {
    extensions: [".web.tsx", ".web.ts", ".web.js", ".web.mjs", ".tsx", ".ts", ".js", ".mjs", ".json"],
    alias: {
      "react-native": "react-native-web",
      "react-native-safe-area-context": fileURLToPath(new URL("./test/stubs/safe-area.tsx", import.meta.url)),
      // Paper's CommonJS entry would be loaded by Node itself and see the Flow source of react-native.
      "react-native-paper": "react-native-paper/lib/module/index.js",
      "expo-secure-store": fileURLToPath(new URL("./test/stubs/secure-store.ts", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.test.tsx"],
    environment: "jsdom",
    server: { deps: { inline: [/react-native-paper/, /react-native-safe-area-context/] } },
  },
})
