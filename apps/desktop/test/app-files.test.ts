import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { resolveAppUrl } from "../src/app-config.js"
import { resolveAppFile } from "../src/app-files.js"
import { preflightStatusLine, withCors } from "../src/cors.js"

let dist = ""

beforeAll(() => {
  dist = mkdtempSync(path.join(tmpdir(), "shoalwork-dist-"))
  mkdirSync(path.join(dist, "_expo", "static"), { recursive: true })
  for (const name of ["index.html", "setup.html", "+not-found.html", "_expo/static/app.js"]) {
    writeFileSync(path.join(dist, name), name)
  }
  writeFileSync(path.join(dist, "..", "secret.txt"), "outside")
})

afterAll(() => {
  rmSync(path.join(dist, "..", "secret.txt"), { force: true })
  rmSync(dist, { recursive: true, force: true })
})

describe("resolveAppFile", () => {
  it("serves index.html at the root", () => {
    expect(resolveAppFile(dist, "/")).toBe(path.join(dist, "index.html"))
  })

  it("maps a route to its html file", () => {
    expect(resolveAppFile(dist, "/setup")).toBe(path.join(dist, "setup.html"))
    expect(resolveAppFile(dist, "/setup/")).toBe(path.join(dist, "setup.html"))
  })

  it("serves assets as they are", () => {
    expect(resolveAppFile(dist, "/_expo/static/app.js")).toBe(path.join(dist, "_expo", "static", "app.js"))
  })

  it("falls back to the not-found page for an unknown route", () => {
    expect(resolveAppFile(dist, "/nope")).toBe(path.join(dist, "+not-found.html"))
  })

  it("answers undefined for an unknown asset instead of the not-found page", () => {
    expect(resolveAppFile(dist, "/_expo/static/missing.js")).toBeUndefined()
  })

  it("never leaves the dist folder", () => {
    expect(resolveAppFile(dist, "/../secret.txt")).toBeUndefined()
    expect(resolveAppFile(dist, "/../outside")).toBeUndefined()
    expect(resolveAppFile(dist, `/../${path.basename(dist)}-evil/index`)).toBeUndefined()
  })
})

describe("resolveAppUrl", () => {
  it("uses APP_URL when set", () => {
    expect(resolveAppUrl({ APP_URL: " http://10.0.0.5:9000 " })).toBe("http://10.0.0.5:9000")
  })

  it("falls back to the local port", () => {
    expect(resolveAppUrl({ APP_URL: "" })).toBe("http://127.0.0.1:28900")
    expect(resolveAppUrl({ PORT: "3100" })).toBe("http://127.0.0.1:3100")
  })
})

describe("cors", () => {
  it("replaces any CORS header and keeps the others", () => {
    const headers = withCors(
      { "Access-Control-Allow-Origin": "*", "content-type": "application/json" },
      "shoalwork://app",
    )
    expect(headers).toMatchObject({
      "content-type": "application/json",
      "access-control-allow-origin": "shoalwork://app",
    })
    expect(headers).not.toHaveProperty("Access-Control-Allow-Origin")
    expect(String(headers["access-control-allow-headers"])).toContain("last-event-id")
  })

  it("turns a preflight into a 204 and leaves other methods alone", () => {
    expect(preflightStatusLine("OPTIONS")).toBe("HTTP/1.1 204 No Content")
    expect(preflightStatusLine("GET")).toBeUndefined()
  })
})
