import { describe, expect, it } from "vitest"
import { REPO_ROOT, resolveDatabasePath } from "../src/config.js"

describe("resolveDatabasePath", () => {
  it("anchors a relative path to the repo root, not the cwd", () => {
    expect(resolveDatabasePath("./data/shoalwork.db", "/repo")).toBe("/repo/data/shoalwork.db")
  })

  it("keeps an absolute path as it is", () => {
    expect(resolveDatabasePath("/var/tmp/t.db", "/repo")).toBe("/var/tmp/t.db")
  })

  it("defaults the root to the directory that holds the repo package.json", () => {
    expect(resolveDatabasePath("./data/shoalwork.db")).toBe(`${REPO_ROOT}data/shoalwork.db`)
  })
})
