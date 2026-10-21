import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

// The screens are React Native; in tests react-native-web renders them in jsdom.
export default defineConfig({
  resolve: {
    // One copy of effect for the screens and for @shoalwork/contracts (dist resolves it from its own package).
    // Two copies of the same version break Schema's internal checks (RegExp filters throw on Symbol keys).
    dedupe: ["effect"],
    extensions: [".web.tsx", ".web.ts", ".web.js", ".web.mjs", ".tsx", ".ts", ".js", ".mjs", ".json"],
    alias: {
      "react-native": "react-native-web",
      "react-native-safe-area-context": fileURLToPath(new URL("./test/stubs/safe-area.tsx", import.meta.url)),
      // Paper's CommonJS entry would be loaded by Node itself and see the Flow source of react-native.
      "react-native-paper": "react-native-paper/lib/module/index.js",
      "expo-secure-store": fileURLToPath(new URL("./test/stubs/secure-store.ts", import.meta.url)),
      // The SVG package is not loadable under Node; the stub draws its primitives as plain SVG elements.
      "react-native-svg": fileURLToPath(new URL("./test/stubs/react-native-svg.tsx", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.test.tsx"],
    environment: "jsdom",
    // Screens rendered by react-native-web in jsdom take seconds on the CI runner; the default 5 s is too tight.
    testTimeout: 20_000,
    server: { deps: { inline: [/react-native-paper/, /react-native-safe-area-context/] } },
  },
})
