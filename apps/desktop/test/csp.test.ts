import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { CoreOrigins, originOf } from "../src/core-origins.js"
import { buildCsp, inlineScriptHashes } from "../src/csp.js"

const sha = (text: string): string => `'sha256-${createHash("sha256").update(text).digest("base64")}'`

describe("inlineScriptHashes", () => {
  it("hashes inline scripts and skips external ones", () => {
    const html = `<html><head><script src="/a.js" defer></script></head><body><script id="_R_">window.x=1</script></body></html>`
    expect(inlineScriptHashes(html)).toEqual([sha("window.x=1")])
  })

  it("returns nothing for a page without inline scripts", () => {
    expect(inlineScriptHashes(`<script src="/a.js"></script>`)).toEqual([])
  })
})

describe("buildCsp", () => {
  const csp = buildCsp({
    scriptHashes: [sha("window.x=1")],
    connectOrigins: ["http://127.0.0.1:28900", "https://core.example.com"],
  })
  const directives = new Map(csp.split("; ").map((part) => [part.split(" ")[0], part] as const))

  it("allows only the app, the page's own inline script and the configured cores", () => {
    expect(directives.get("default-src")).toBe("default-src 'self'")
    expect(directives.get("script-src")).toBe(`script-src 'self' ${sha("window.x=1")}`)
    expect(directives.get("connect-src")).toBe(
      "connect-src 'self' http://127.0.0.1:28900 https://core.example.com",
    )
  })

  it("locks objects, base and framing and never allows eval", () => {
    expect(directives.get("object-src")).toBe("object-src 'none'")
    expect(directives.get("base-uri")).toBe("base-uri 'none'")
    expect(directives.get("frame-ancestors")).toBe("frame-ancestors 'none'")
    expect(csp).not.toContain("unsafe-eval")
    expect(directives.get("script-src")).not.toContain("unsafe-inline")
  })
})

describe("CoreOrigins", () => {
  it("keeps origins, ignores paths and rejects non-http values", () => {
    const origins = new CoreOrigins(["http://127.0.0.1:28900/"])
    expect(origins.add("https://core.example.com/some/path")).toBe(true)
    expect(origins.add("javascript:alert(1)")).toBe(false)
    expect(origins.add("not a url")).toBe(false)
    expect(origins.list()).toEqual(["http://127.0.0.1:28900", "https://core.example.com"])
    expect(origins.has("http://127.0.0.1:28900/events/live")).toBe(true)
    expect(origins.has("http://evil.example.com/")).toBe(false)
  })

  it("computes the origin of a URL", () => {
    expect(originOf("http://localhost:3000/x?y=1")).toBe("http://localhost:3000")
    expect(originOf("file:///etc/passwd")).toBeUndefined()
  })
})
