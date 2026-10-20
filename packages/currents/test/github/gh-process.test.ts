import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { afterAll, describe, expect } from "vitest"
import { makeGhClient, runGhProcess } from "../../src/index.js"

// A fake gh on PATH. Its env is dumped to a file, so the test sees exactly what the process received.
// MODE=hang: starts a grandchild in the same group and sleeps. MODE=fail: two stderr lines, exit 1.
const root = mkdtempSync(join(tmpdir(), "shoalwork-fake-gh-"))
const binDir = join(root, "bin")
const outDir = join(root, "out")
const SCRIPT = `#!/bin/sh
printenv | sort > "$OUT_DIR/env.txt"
case "$MODE" in
  hang)
    sleep 30 &
    echo $! > "$OUT_DIR/grandchild.pid"
    sleep 30
    ;;
  fail)
    echo "first line of stderr" >&2
    echo "SECRET-SECOND-LINE" >&2
    exit 1
    ;;
esac
exit 0
`
mkdirSync(binDir, { recursive: true })
mkdirSync(outDir, { recursive: true })
writeFileSync(join(binDir, "gh"), SCRIPT)
chmodSync(join(binDir, "gh"), 0o755)

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const envFor = (mode: string): Record<string, string> => ({
  PATH: `${binDir}:/bin:/usr/bin`,
  HOME: join(root, "home"),
  OUT_DIR: outDir,
  MODE: mode,
})

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (_cause) {
    return false
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("runGhProcess", () => {
  it("runs gh with exactly the env it was given, not the test process env", async () => {
    process.env.SHOALWORK_PARENT_ONLY = "from-the-test-process"
    try {
      const output = await Effect.runPromise(
        runGhProcess("gh pr view", ["gh", "pr", "view"], envFor("fail"), undefined, 10_000),
      )
      expect(output.exitCode).toBe(1)
      const seen = readFileSync(join(outDir, "env.txt"), "utf8")
      expect(seen).not.toContain("SHOALWORK_PARENT_ONLY")
      const keys = seen
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => line.slice(0, line.indexOf("=")))
        .filter((key) => !["PWD", "SHLVL", "_", "OLDPWD"].includes(key))
        .sort()
      expect(keys).toEqual(Object.keys(envFor("fail")).sort())
    } finally {
      delete process.env.SHOALWORK_PARENT_ONLY
    }
  }, 15_000)

  it("a timeout kills the whole process group, the grandchild included", async () => {
    const output = await Effect.runPromise(
      runGhProcess("gh pr view", ["gh", "pr", "view"], envFor("hang"), undefined, 400),
    )
    expect(output.timedOut).toBe(true)
    const pid = Number(readFileSync(join(outDir, "grandchild.pid"), "utf8").trim())
    for (let attempt = 0; attempt < 30 && alive(pid); attempt += 1) {
      await sleep(100)
    }
    expect(alive(pid)).toBe(false)
  }, 15_000)

  it("a GhError from a failed call carries the first stderr line and never the rest", async () => {
    const client = makeGhClient(runGhProcess, envFor("fail"))
    const failure = await Effect.runPromise(Effect.flip(client.prView("a/b", 1)))
    expect(failure.message).toBe("gh pr view exited 1: first line of stderr")
    expect(failure.message).not.toContain("SECRET-SECOND-LINE")
  }, 15_000)

  it("a missing gh binary is a GhError, not a crash", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        runGhProcess("gh pr view", ["gh", "pr", "view"], { PATH: join(root, "empty") }, undefined, 5_000),
      ),
    )
    expect(failure.message).toBe("gh pr view could not run")
    expect(existsSync(join(root, "empty"))).toBe(false)
  }, 15_000)
})
