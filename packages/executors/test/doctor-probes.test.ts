import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { afterAll, describe, expect } from "vitest"
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  DoctorConfig,
  type DoctorReport,
  doctor,
  type ExecutorVersions,
} from "../src/doctor.js"

const PINNED: ExecutorVersions = {
  "claude-code": "2.1.304",
  codex: "0.155.1",
  gemini: "0.59.0",
  opencode: "1.19.3",
}

const root = mkdtempSync(join(tmpdir(), "doctor-probes-test-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

let sandboxes = 0

// A fresh PATH with one sh script per name and a fresh HOME. The env holds nothing else.
const sandbox = (
  scripts: Record<string, string>,
  extra: Record<string, string> = {},
  files: ReadonlyArray<string> = [],
) => {
  sandboxes += 1
  const bin = join(root, `bin-${sandboxes}`)
  const home = join(root, `home-${sandboxes}`)
  mkdirSync(bin, { recursive: true })
  mkdirSync(home, { recursive: true })
  for (const [name, body] of Object.entries(scripts)) {
    const path = join(bin, name)
    // The sandbox PATH holds only the fakes: the system tools a fake uses (sleep, touch) come from the usual folders.
    writeFileSync(path, `#!/bin/sh\nPATH="$PATH:/bin:/usr/bin"\n${body}\n`)
    chmodSync(path, 0o755)
  }
  for (const file of files) {
    const path = join(home, file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, "{}")
  }
  return { PATH: bin, HOME: home, ...extra }
}

const run = (env: Record<string, string>, timeoutMs?: number) =>
  doctor().pipe(
    Effect.provide(
      Layer.succeed(
        DoctorConfig,
        timeoutMs === undefined ? { pinned: PINNED, env } : { pinned: PINNED, env, timeoutMs },
      ),
    ),
  )

const find = (reports: ReadonlyArray<DoctorReport>, executor: string): DoctorReport => {
  const report = reports.find((candidate) => candidate.executor === executor)
  if (report === undefined) throw new Error(`no report for ${executor}`)
  return report
}

describe("doctor probes", () => {
  it("defaults each CLI call to 30 seconds", () => {
    expect(DEFAULT_PROBE_TIMEOUT_MS).toBe(30_000)
  })

  it.live(
    "probes the four CLIs at once: each waits for the others to start, so a sequential run would fail",
    () =>
      Effect.gen(function* () {
        // Every --version touches its own marker, then waits until all four markers exist (at most ~10 s). Run one at a
        // time, the first probe would wait with nobody else started and exit 7.
        const marks = join(root, `marks-${sandboxes + 1}`)
        mkdirSync(marks, { recursive: true })
        const names = ["claude", "codex", "gemini", "opencode"]
        const wait = (name: string) =>
          `touch "${join(marks, name)}"; i=0; while ! { ${names.map((other) => `[ -f "${join(marks, other)}" ]`).join(" && ")}; }; do sleep 0.1; i=$((i+1)); [ $i -gt 100 ] && exit 7; done`
        const env = sandbox(
          {
            claude: `${wait("claude")}\ncase "$1" in --version) echo "2.1.304 (Claude Code)" ;; auth) echo '{"authMethod":"claude.ai"}' ;; esac`,
            codex: `${wait("codex")}\ncase "$1" in --version) echo "codex-cli 0.155.1" ;; login) exit 0 ;; esac`,
            gemini: `${wait("gemini")}\necho "0.59.0"`,
            opencode: `${wait("opencode")}\necho "1.19.3"`,
          },
          { GEMINI_API_KEY: "fixture-key" },
          [".local/share/opencode/auth.json"],
        )
        const reports = yield* run(env)
        expect(reports.map((report) => report.status)).toEqual(["ok", "ok", "ok", "ok"])
        expect(reports.map((report) => report.executor)).toEqual([
          "claude-code",
          "codex",
          "gemini",
          "opencode",
        ])
      }),
  )

  it.live("a probe that outlasts the timeout is missing, and the others still report", () =>
    Effect.gen(function* () {
      const env = sandbox(
        {
          claude: `sleep 5\necho "2.1.304"`,
          codex: `case "$1" in --version) echo "codex-cli 0.155.1" ;; login) exit 0 ;; esac`,
          gemini: `echo "0.59.0"`,
          opencode: `echo "1.19.3"`,
        },
        { GEMINI_API_KEY: "fixture-key" },
        [".local/share/opencode/auth.json"],
      )
      const reports = yield* run(env, 300)
      expect(find(reports, "claude-code")).toMatchObject({
        status: "missing",
        detail: "claude --version timed out",
      })
      expect(find(reports, "codex").status).toBe("ok")
    }),
  )
})
