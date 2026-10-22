import fs from "node:fs/promises"
import path from "node:path"
import { MakerDMG } from "@electron-forge/maker-dmg"
import { MakerZIP } from "@electron-forge/maker-zip"
import { VitePlugin } from "@electron-forge/plugin-vite"
import type { ForgeConfig } from "@electron-forge/shared-types"

const config: ForgeConfig = {
  packagerConfig: {
    name: "shoalwork",
    icon: "assets/icon",
    asar: true,
    // The static Expo export, read at runtime from process.resourcesPath/dist.
    extraResource: ["../web/dist"],
  },
  makers: [new MakerDMG({ name: "shoalwork" }, ["darwin"]), new MakerZIP({}, ["darwin"])],
  plugins: [
    new VitePlugin({
      build: [
        { entry: "src/main.ts", config: "vite.main.config.ts", target: "main" },
        { entry: "src/preload.ts", config: "vite.preload.config.ts", target: "preload" },
      ],
      renderer: [],
    }),
  ],
  hooks: {
    postMake: async (_forgeConfig, makeResults) => {
      const makeDir = path.resolve("out", "make")
      await fs.mkdir(makeDir, { recursive: true })
      for (const res of makeResults) {
        for (const artifact of res.artifacts) {
          if (artifact.endsWith(".dmg")) {
            const dest = path.join(makeDir, path.basename(artifact))
            if (artifact !== dest) {
              await fs.copyFile(artifact, dest)
            }
          }
        }
      }
    },
  },
}

export default config
