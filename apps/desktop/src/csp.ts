import { createHash } from "node:crypto"

const INLINE_SCRIPT = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g

// 'sha256-…' sources for every inline <script> of an exported page; the export has one tiny React marker script.
export const inlineScriptHashes = (html: string): Array<string> =>
  [...html.matchAll(INLINE_SCRIPT)].map(
    (match) =>
      `'sha256-${createHash("sha256")
        .update(match[1] ?? "")
        .digest("base64")}'`,
  )

export interface CspInput {
  readonly scriptHashes: ReadonlyArray<string>
  // Origins of the core the page may call (APP_URL and the base URL saved in Setup).
  readonly connectOrigins: ReadonlyArray<string>
}

export const buildCsp = ({ scriptHashes, connectOrigins }: CspInput): string =>
  [
    "default-src 'self'",
    `script-src ${["'self'", ...scriptHashes].join(" ")}`,
    // React Native Web injects its stylesheet at runtime.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    `connect-src ${["'self'", ...connectOrigins].join(" ")}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ")
