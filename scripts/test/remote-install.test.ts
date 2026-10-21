import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const script = fileURLToPath(new URL("../deploy/test/remote-install.test.sh", import.meta.url))

describe("remote-install.sh", () => {
  it("installs a good release and rolls back a broken one", () => {
    const result = spawnSync("bash", [script], { encoding: "utf8", timeout: 30_000 })
    const stdout = result.stdout ?? ""
    const stderr = result.stderr ?? ""
    if (result.status !== 0) {
      throw new Error(`remote-install test exited ${result.status}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`)
    }
    expect(stdout).toContain("step 1: install good release v-good")
    expect(stdout).toContain("step 2: install broken release v-bad")
    expect(stdout).toContain("PASS")
  })
})
