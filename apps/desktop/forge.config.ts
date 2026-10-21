import { VitePlugin } from "@electron-forge/plugin-vite"

export default {
  packagerConfig: {
    name: "Shoalwork",
    asar: true,
    // The static Expo export, read at runtime from process.resourcesPath/dist.
    extraResource: ["../web/dist"],
  },
  plugins: [
    new VitePlugin({
      build: [
        { entry: "src/main.ts", config: "vite.main.config.ts", target: "main" },
        { entry: "src/preload.ts", config: "vite.preload.config.ts", target: "preload" },
      ],
      renderer: [],
    }),
  ],
}
