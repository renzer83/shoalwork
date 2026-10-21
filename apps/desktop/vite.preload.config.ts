import { builtinModules } from "node:module"
import { defineConfig } from "vite"

export default defineConfig({
  build: {
    outDir: ".vite/build",
    emptyOutDir: false,
    copyPublicDir: false,
    lib: { entry: "src/preload.ts", fileName: () => "preload.cjs", formats: ["cjs"] },
    rollupOptions: {
      external: ["electron", ...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
    },
  },
})
