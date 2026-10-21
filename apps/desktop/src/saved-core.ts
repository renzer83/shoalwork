import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { originOf } from "./core-origins.js"

const FILE = "core-url.json"

// The core URL saved in Setup, kept in the user data folder so the first page load after a restart already allows it.
export const loadSavedCoreUrl = (dir: string): string | undefined => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(dir, FILE), "utf8"))
    const url = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "url") : undefined
    return typeof url === "string" && originOf(url) !== undefined ? url : undefined
  } catch {
    return undefined
  }
}

export const saveCoreUrl = (dir: string, url: string): void => {
  try {
    writeFileSync(path.join(dir, FILE), JSON.stringify({ url }))
  } catch {
    // Not fatal: the next restart falls back to APP_URL until Setup is saved again.
  }
}
