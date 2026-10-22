import { existsSync, statSync } from "node:fs"
import path from "node:path"

export const APP_SCHEME = "shoalwork"
export const APP_ORIGIN = `${APP_SCHEME}://app`

const isFile = (candidate: string): boolean => existsSync(candidate) && statSync(candidate).isFile()

export interface ResolveDistOptions {
  isPackaged: boolean
  resourcesPath?: string
  baseDir?: string
}

// Resolves the static Expo web export directory: from process.resourcesPath/dist when packaged,
// or from the workspace (apps/web/dist) in development.
export const resolveDistDir = (
  env: boolean | ResolveDistOptions,
  resourcesPath?: string,
  baseDir?: string,
): string => {
  if (typeof env === "object") {
    if (env.isPackaged) {
      return path.join(env.resourcesPath ?? process.resourcesPath ?? "", "dist")
    }
    const base = env.baseDir ?? (typeof __dirname !== "undefined" ? __dirname : process.cwd())
    return path.resolve(base, "../../../web/dist")
  }
  if (env) {
    return path.join(resourcesPath ?? process.resourcesPath ?? "", "dist")
  }
  const base = baseDir ?? (typeof __dirname !== "undefined" ? __dirname : process.cwd())
  return path.resolve(base, "../../../web/dist")
}

// Maps a URL path of the static Expo export to a file inside `distDir`: "/" is index.html, a route like "/setup" is
// setup.html, an asset is itself. An unknown route falls back to the not-found page; an unknown asset (a path with a
// file extension) or anything outside distDir is undefined, which the caller answers with 404.
export const resolveAppFile = (distDir: string, urlPath: string): string | undefined => {
  const root = path.resolve(distDir)
  const clean = urlPath.replace(/^\/+/, "").replace(/\/+$/, "")
  const candidates = clean === "" ? ["index.html"] : [clean, `${clean}.html`, path.join(clean, "index.html")]
  for (const candidate of candidates) {
    const resolved = path.resolve(root, candidate)
    if (resolved.startsWith(root + path.sep) && isFile(resolved)) {
      return resolved
    }
  }
  const target = path.resolve(root, clean)
  const escapes = target !== root && !target.startsWith(root + path.sep)
  return escapes || path.extname(clean) !== "" ? undefined : path.join(root, "+not-found.html")
}
