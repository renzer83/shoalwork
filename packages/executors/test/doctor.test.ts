import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { afterAll, describe, expect } from "vitest"
import {
  DoctorConfig,
  type DoctorReport,
  doctor,
  type ExecutorVersions,
  loadExecutorVersions,
  parseSemver,
} from "../src/doctor.js"

type Env = Readonly<Record<string, string>>

// Same values as config/executor-versions.yaml: the versions the fixtures were recorded with.
const PINNED: ExecutorVersions = {
  "claude-code": "2.1.304",
  codex: "0.155.1",
  gemini: "0.59.0",
  opencode: "1.19.3",
}

const root = mkdtempSync(join(tmpdir(), "doctor-test-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

let sandboxes = 0

// A fresh PATH with one sh script per name (only those exist) and a fresh HOME holding `files` (relative to HOME).
// The env holds nothing else, so the doctor sees exactly what the test sets up.
const sandbox = (
  scripts: Record<string, string>,
  extra: Env = {},
  files: ReadonlyArray<string> = [],
): Env => {
  sandboxes += 1
  const bin = join(root, `bin-${sandboxes}`)
  const home = join(root, `home-${sandboxes}`)
  mkdirSync(bin, { recursive: true })
  mkdirSync(home, { recursive: true })
  for (const [name, body] of Object.entries(scripts)) {
    const path = join(bin, name)
    writeFileSync(path, `#!/bin/sh\n${body}\n`)
    chmodSync(path, 0o755)
  }
  for (const file of files) {
    const path = join(home, file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, "{}")
  }
  return { PATH: bin, HOME: home, ...extra }
}

const CLAUDE_LOGGED_IN = `case "$1" in --version) echo "2.1.304 (Claude Code)" ;; auth) echo '{"authMethod":"claude.ai"}' ;; esac`
const CLAUDE_LOGGED_OUT = `case "$1" in --version) echo "2.1.304 (Claude Code)" ;; auth) echo '{"authMethod":"none"}' ;; esac`
const CODEX_LOGGED_IN = `case "$1" in --version) echo "codex-cli 0.155.1" ;; login) exit 0 ;; esac`
const CODEX_NEWER_LOGGED_IN = `case "$1" in --version) echo "codex-cli 0.163.0" ;; login) exit 0 ;; esac`
const CODEX_NEWER_LOGGED_OUT = `case "$1" in --version) echo "codex-cli 0.163.0" ;; login) exit 1 ;; esac`
const OPENCODE_VERSION = `echo "1.19.3"`
const GEMINI_VERSION = `echo "0.59.0"`

const ALL_OK = {
  claude: CLAUDE_LOGGED_IN,
  codex: CODEX_LOGGED_IN,
  gemini: GEMINI_VERSION,
  opencode: OPENCODE_VERSION,
}
const GEMINI_KEY: Env = { GEMINI_API_KEY: "fixture-key" }
const OPENCODE_AUTH = [".local/share/opencode/auth.json"]

const diagnose = (env: Env, pinned: ExecutorVersions = PINNED) =>
  doctor().pipe(Effect.provide(Layer.succeed(DoctorConfig, { pinned, env })))

const find = (reports: ReadonlyArray<DoctorReport>, executor: string): DoctorReport => {
  const report = reports.find((candidate) => candidate.executor === executor)
  if (report === undefined) throw new Error(`no report for ${executor}`)
  return report
}

describe("doctor", () => {
  it.live("reports ok for CLIs that match their pins and are logged in", () =>
    Effect.gen(function* () {
      const reports = yield* diagnose(sandbox(ALL_OK, GEMINI_KEY, OPENCODE_AUTH))
      expect(reports.map((report) => report.status)).toEqual(["ok", "ok", "ok", "ok"])
      expect(find(reports, "claude-code")).toMatchObject({
        bin: "claude",
        installed: "2.1.304",
        pinned: "2.1.304",
      })
      expect(find(reports, "codex")).toMatchObject({ installed: "0.155.1", pinned: "0.155.1" })
      expect(find(reports, "opencode").detail).toBeUndefined()
    }),
  )

  it.live("reports drift when the installed version differs from the pin", () =>
    Effect.gen(function* () {
      const reports = yield* diagnose(
        sandbox({ ...ALL_OK, codex: CODEX_NEWER_LOGGED_IN }, GEMINI_KEY, OPENCODE_AUTH),
      )
      expect(find(reports, "codex")).toEqual({
        executor: "codex",
        bin: "codex",
        installed: "0.163.0",
        pinned: "0.155.1",
        status: "drift",
        detail: "installed 0.163.0, pinned 0.155.1",
      })
    }),
  )

  it.live("reports missing when the binary is not on PATH", () =>
    Effect.gen(function* () {
      const reports = yield* diagnose(
        sandbox(
          { claude: CLAUDE_LOGGED_IN, codex: CODEX_LOGGED_IN, opencode: OPENCODE_VERSION },
          {},
          OPENCODE_AUTH,
        ),
      )
      expect(find(reports, "gemini")).toMatchObject({
        status: "missing",
        installed: null,
        detail: "cannot run gemini",
      })
    }),
  )

  it.live("reports missing when --version exits non-zero or prints no version", () =>
    Effect.gen(function* () {
      const reports = yield* diagnose(
        sandbox({ ...ALL_OK, gemini: "exit 3", opencode: `echo "hello"` }, GEMINI_KEY),
      )
      expect(find(reports, "gemini")).toMatchObject({
        status: "missing",
        detail: "gemini --version exited 3",
      })
      expect(find(reports, "opencode")).toMatchObject({
        status: "missing",
        detail: "no version number in opencode --version output",
      })
    }),
  )

  it.live("reports auth_missing when claude auth status says authMethod none", () =>
    Effect.gen(function* () {
      const reports = yield* diagnose(
        sandbox({ ...ALL_OK, claude: CLAUDE_LOGGED_OUT }, GEMINI_KEY, OPENCODE_AUTH),
      )
      expect(find(reports, "claude-code")).toMatchObject({
        status: "auth_missing",
        installed: "2.1.304",
        detail: "not logged in (authMethod none)",
      })
    }),
  )

  it.live(
    "reports auth_missing for gemini without a key or credentials file, and for opencode without auth.json",
    () =>
      Effect.gen(function* () {
        const reports = yield* diagnose(sandbox(ALL_OK))
        expect(find(reports, "gemini")).toMatchObject({
          status: "auth_missing",
          detail: "no GEMINI_API_KEY and no .gemini/oauth_creds.json",
        })
        expect(find(reports, "opencode")).toMatchObject({
          status: "auth_missing",
          detail: "no opencode/auth.json",
        })
      }),
  )

  it.live("accepts gemini credentials from GEMINI_CLI_HOME/.gemini/oauth_creds.json", () =>
    Effect.gen(function* () {
      const cliHome = join(root, "gemini-cli-home")
      mkdirSync(join(cliHome, ".gemini"), { recursive: true })
      writeFileSync(join(cliHome, ".gemini", "oauth_creds.json"), "{}")
      const reports = yield* diagnose({ ...sandbox({ gemini: GEMINI_VERSION }), GEMINI_CLI_HOME: cliHome })
      expect(find(reports, "gemini").status).toBe("ok")
    }),
  )

  it.live("keeps the drift in detail when a drifted CLI is also not logged in", () =>
    Effect.gen(function* () {
      const reports = yield* diagnose(
        sandbox({ ...ALL_OK, codex: CODEX_NEWER_LOGGED_OUT }, GEMINI_KEY, OPENCODE_AUTH),
      )
      expect(find(reports, "codex")).toMatchObject({
        status: "auth_missing",
        installed: "0.163.0",
        detail: "codex login status failed; installed 0.163.0, pinned 0.155.1",
      })
    }),
  )

  it.live("reports every executor and never fails, even with nothing installed", () =>
    Effect.gen(function* () {
      const reports = yield* diagnose({ PATH: join(root, "no-such-dir"), HOME: root })
      expect(reports.map((report) => report.executor)).toEqual(["claude-code", "codex", "gemini", "opencode"])
      expect(reports.every((report) => report.status === "missing")).toBe(true)
    }),
  )
})

describe("parseSemver", () => {
  it("reads the version out of each CLI's --version text", () => {
    expect(parseSemver("2.1.306 (Claude Code)")).toBe("2.1.306")
    expect(parseSemver("codex-cli 0.155.1")).toBe("0.155.1")
    expect(parseSemver("0.59.0")).toBe("0.59.0")
    expect(parseSemver("no version here")).toBeNull()
  })
})

describe("loadExecutorVersions", () => {
  it.effect("loads config/executor-versions.yaml with all four pins", () =>
    Effect.gen(function* () {
      const path = fileURLToPath(new URL("../../../config/executor-versions.yaml", import.meta.url))
      const pins = yield* loadExecutorVersions(path)
      expect(pins).toEqual({
        "claude-code": "2.1.304",
        codex: "0.155.1",
        gemini: "0.59.0",
        opencode: "1.19.3",
      })
    }),
  )

  it.effect("rejects a pin that is not a semver and a file missing a pin", () =>
    Effect.gen(function* () {
      const badPath = join(root, "bad-pin.yaml")
      writeFileSync(badPath, 'claude-code: "2.1"\ncodex: "0.155.1"\ngemini: "0.59.0"\nopencode: "1.19.3"\n')
      const badPin = yield* loadExecutorVersions(badPath).pipe(Effect.flip)
      expect(badPin._tag).toBe("ConfigError")

      const missingPath = join(root, "missing-pin.yaml")
      writeFileSync(missingPath, 'codex: "0.155.1"\ngemini: "0.59.0"\nopencode: "1.19.3"\n')
      const missing = yield* loadExecutorVersions(missingPath).pipe(Effect.flip)
      expect(missing._tag).toBe("ConfigError")
    }),
  )
})
