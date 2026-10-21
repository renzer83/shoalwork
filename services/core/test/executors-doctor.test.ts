import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Beacon, BeaconLive } from "@shoalwork/beacon"
import { ExecutorId, streamIds } from "@shoalwork/contracts"
import { withTempDb } from "@shoalwork/db/testing"
import { type DoctorReport, ExecutorRegistry, QuotaConfig, QuotaStoreLive } from "@shoalwork/executors"
import { Deferred, Effect, Layer, ManagedRuntime, Redacted, Schema, Stream } from "effect"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { type DoctorRun, hostDoctor, RegistryFromConfig } from "../src/executors-compose.js"
import { makeApp } from "../src/http/app.js"
import type { RunEffect } from "../src/http/routes/respond.js"
import { DEFAULT_TIERS } from "../src/model-tiers.js"

const TOKEN = "test-token"
const AUTH = { authorization: `Bearer ${TOKEN}` }
const ReportsBody = Schema.Struct({
  reports: Schema.Array(Schema.Struct({ executor: Schema.String, status: Schema.String })),
})

// Synthetic: no quota windows at all, so every executor's availability is the doctor's and nothing else.
const quotaConfig = Schema.decodeUnknownSync(QuotaConfig)({ executors: {} })
const CONFIG = { permissionBridge: false, codexModel: undefined } as const

// The registry, store and Beacon as the core composes them, over a temporary database. Without a doctorRun the probes
// are the host's: they read the PATH and HOME each test stubs, so every CLI they probe is one of the fake scripts.
const layerWith = (doctorRun?: DoctorRun) =>
  RegistryFromConfig(CONFIG, DEFAULT_TIERS, quotaConfig, doctorRun).pipe(
    Layer.provideMerge(QuotaStoreLive(quotaConfig)),
    Layer.provideMerge(Layer.provideMerge(BeaconLive, withTempDb())),
  )
type Built = Layer.Success<ReturnType<typeof layerWith>>
type Runtime = ManagedRuntime.ManagedRuntime<Built, Layer.Error<ReturnType<typeof layerWith>>>

const root = mkdtempSync(join(tmpdir(), "core-doctor-test-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

let hosts = 0

// Fake CLIs: one sh script per name in a fresh PATH folder, and a fresh HOME. Only the scripts given exist.
type Host = {
  readonly scripts: Readonly<Record<string, string>>
  readonly authFiles?: ReadonlyArray<string>
  readonly geminiKey?: boolean
}

const useHost = ({ scripts, authFiles = [], geminiKey = false }: Host): void => {
  hosts += 1
  const bin = join(root, `bin-${hosts}`)
  const home = join(root, `home-${hosts}`)
  mkdirSync(bin, { recursive: true })
  for (const [name, body] of Object.entries(scripts)) {
    const path = join(bin, name)
    // The sandbox PATH holds only the fakes: the system tools a fake uses (sleep, touch) come from the usual folders.
    writeFileSync(path, `#!/bin/sh\nPATH="$PATH:/bin:/usr/bin"\n${body}\n`)
    chmodSync(path, 0o755)
  }
  for (const file of authFiles) {
    const path = join(home, file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, "{}")
  }
  // Every env name the doctor reads is pinned here, so the host's own login does not decide the outcome.
  vi.stubEnv("PATH", bin)
  vi.stubEnv("HOME", home)
  vi.stubEnv("XDG_DATA_HOME", join(home, ".local", "share"))
  vi.stubEnv("GEMINI_CLI_HOME", home)
  vi.stubEnv("GEMINI_API_KEY", geminiKey ? "fixture-key" : "")
}

const CLAUDE_LOGGED_IN = `[ -n "$SHOALWORK_PROBE" ] && exit 9
case "$1" in --version) echo "2.1.304 (Claude Code)" ;; auth) echo '{"authMethod":"claude.ai"}' ;; esac`
const CLAUDE_LOGGED_OUT = `case "$1" in --version) echo "2.1.304 (Claude Code)" ;; auth) echo '{"authMethod":"none"}' ;; esac`
const CODEX_PINNED = `case "$1" in --version) echo "codex-cli 0.155.1" ;; login) exit 0 ;; esac`
const CODEX_NEWER = `case "$1" in --version) echo "codex-cli 0.163.0" ;; login) exit 0 ;; esac`
const GEMINI_PINNED = `echo "0.59.0"`
const OPENCODE_PINNED = `echo "1.19.3"`
const OPENCODE_AUTH = [".local/share/opencode/auth.json"]

const EVERYTHING_OK: Host = {
  scripts: {
    claude: CLAUDE_LOGGED_IN,
    codex: CODEX_PINNED,
    gemini: GEMINI_PINNED,
    opencode: OPENCODE_PINNED,
  },
  authFiles: OPENCODE_AUTH,
  geminiKey: true,
}

// A fresh runtime per test: each boot starts its own probes and reads its own events. The runtime is disposed after
// the body, which stops any probe still running.
const withRuntime = async <A>(body: (runtime: Runtime) => Promise<A>, doctorRun?: DoctorRun): Promise<A> => {
  const runtime = ManagedRuntime.make(layerWith(doctorRun))
  try {
    return await body(runtime)
  } finally {
    await runtime.dispose()
  }
}

const availability = (runtime: Runtime, id: string): Promise<boolean> =>
  runtime.runPromise(
    Effect.gen(function* () {
      const registry = yield* ExecutorRegistry
      const executor = yield* registry.get(Schema.decodeUnknownSync(ExecutorId)(id))
      const status = yield* executor.quota()
      return status.available
    }),
  )

// The events of the system stream, read back from the Beacon the boot wrote to.
const systemEvents = (runtime: Runtime) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const beacon = yield* Beacon
      const events = yield* Stream.runCollect(beacon.readStream(streamIds.system))
      return Array.from(events).map((event) => ({
        type: event.type,
        payload: event.payload,
        actor: event.actor,
      }))
    }),
  )

// The boot's probes run in the background, so a test waits for the event it expects (bounded: 5 s).
const waitForTag = async (runtime: Runtime, tag: string) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const raised = (await systemEvents(runtime)).filter(
      (event) => event.type === "error.raised" && (event.payload as { readonly tag?: string }).tag === tag,
    )
    if (raised.length > 0) return raised
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`no error.raised with tag ${tag}`)
}

beforeEach(() => {
  vi.stubEnv("SHOALWORK_PROBE", "leak")
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("boot doctor (background)", () => {
  it("records drift as error.raised with where doctor, and keeps the drifted CLI running", async () => {
    useHost({ ...EVERYTHING_OK, scripts: { ...EVERYTHING_OK.scripts, codex: CODEX_NEWER } })
    await withRuntime(async (runtime) => {
      const raised = await waitForTag(runtime, "ExecutorDrift")
      expect(raised).toHaveLength(1)
      expect(raised[0]).toMatchObject({
        actor: "system:doctor",
        payload: {
          where: "doctor",
          tag: "ExecutorDrift",
          message: "codex: installed 0.163.0, pinned 0.155.1",
        },
      })
      expect(await availability(runtime, "codex")).toBe(true)
    })
  })

  it("records nothing when every CLI matches its pin and is logged in", async () => {
    useHost(EVERYTHING_OK)
    await withRuntime(async (runtime) => {
      // The probes are done once the registry answers the same way after they had time to write (no event can come).
      await waitForAvailability(runtime, "claude-code", true)
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect((await systemEvents(runtime)).filter((event) => event.type === "error.raised")).toEqual([])
    })
  })

  it("records a missing CLI as ExecutorMissing and makes every instance of that binary unavailable", async () => {
    useHost({
      ...EVERYTHING_OK,
      scripts: { codex: CODEX_PINNED, gemini: GEMINI_PINNED, opencode: OPENCODE_PINNED },
    })
    await withRuntime(async (runtime) => {
      const raised = await waitForTag(runtime, "ExecutorMissing")
      expect(raised[0]).toMatchObject({
        payload: { where: "doctor", message: "claude-code: cannot run claude" },
      })
      expect(await availability(runtime, "claude-code")).toBe(false)
      expect(await availability(runtime, "claude-code@ollama")).toBe(false)
      expect(await availability(runtime, "codex")).toBe(true)
    })
  })

  it("records a CLI not logged in as ExecutorAuthMissing, and leaves the other binaries alone", async () => {
    useHost({ ...EVERYTHING_OK, scripts: { ...EVERYTHING_OK.scripts, claude: CLAUDE_LOGGED_OUT } })
    await withRuntime(async (runtime) => {
      await waitForTag(runtime, "ExecutorAuthMissing")
      expect(await availability(runtime, "claude-code")).toBe(false)
      expect(await availability(runtime, "codex@ollama")).toBe(true)
    })
  })

  it("makes the ACP gemini agent unavailable when gemini has no key and no credentials file", async () => {
    useHost({ ...EVERYTHING_OK, geminiKey: false })
    await withRuntime(async (runtime) => {
      await waitForTag(runtime, "ExecutorAuthMissing")
      expect(await availability(runtime, "acp-gemini")).toBe(false)
      expect(await availability(runtime, "codex")).toBe(true)
    })
  })

  it("gives the CLIs only the allowlisted env, so a name outside it never reaches a probe", async () => {
    // SHOALWORK_PROBE is set in beforeEach: the claude script exits 9 on it, which would make claude missing.
    useHost(EVERYTHING_OK)
    const reports = await Effect.runPromise(hostDoctor())
    expect(reports.find((report) => report.executor === "claude-code")?.status).toBe("ok")
  })

  it("does not hold the boot: the registry answers while the probes are still running", async () => {
    const release = await Effect.runPromise(Deferred.make<void>())
    const reports: ReadonlyArray<DoctorReport> = [
      {
        executor: Schema.decodeUnknownSync(ExecutorId)("claude-code"),
        bin: "claude",
        installed: null,
        pinned: "2.1.304",
        status: "missing",
        detail: "cannot run claude",
      },
    ]
    const blocked: DoctorRun = () => Deferred.await(release).pipe(Effect.as(reports))
    await withRuntime(async (runtime) => {
      // Built and answering with the probes still held: the boot did not wait for them.
      expect(await availability(runtime, "claude-code")).toBe(true)
      await runtime.runPromise(Deferred.succeed(release, undefined))
      await waitForTag(runtime, "ExecutorMissing")
      expect(await availability(runtime, "claude-code")).toBe(false)
    }, blocked)
  })
})

// Polls the registry until an executor answers the expected availability (bounded: 5 s).
const waitForAvailability = async (runtime: Runtime, id: string, expected: boolean) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await availability(runtime, id)) === expected) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`${id} never became ${expected}`)
}

describe("GET /executors/doctor", () => {
  it("refuses a request without the API token", async () => {
    useHost(EVERYTHING_OK)
    await withRuntime(async (runtime) => {
      const runEffect: RunEffect = <A, E>(eff: Effect.Effect<A, E, Built>) => runtime.runPromise(eff)
      const app = makeApp({ apiToken: Redacted.make(TOKEN), runEffect })
      const response = await app.request("/executors/doctor")
      expect(response.status).toBe(401)
    })
  })

  it("answers the reports of this host, one per CLI", async () => {
    useHost(EVERYTHING_OK)
    await withRuntime(async (runtime) => {
      const runEffect: RunEffect = <A, E>(eff: Effect.Effect<A, E, Built>) => runtime.runPromise(eff)
      const app = makeApp({ apiToken: Redacted.make(TOKEN), runEffect })
      const response = await app.request("/executors/doctor", { headers: AUTH })
      expect(response.status).toBe(200)
      const body = Schema.decodeUnknownSync(ReportsBody)(await response.json())
      expect(body.reports.map((report) => [report.executor, report.status])).toEqual([
        ["claude-code", "ok"],
        ["codex", "ok"],
        ["gemini", "ok"],
        ["opencode", "ok"],
      ])
    })
  })
})
