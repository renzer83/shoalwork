import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { GhError, type GhOutput, type GhRun, makeGhClient } from "../../src/index.js"

const PR_OUT: GhOutput = {
  exitCode: 0,
  stdout: "https://github.com/renzer83/shoalwork-sandbox/pull/5\n",
  stderr: "",
  timedOut: false,
}
const VIEW_OUT: GhOutput = {
  exitCode: 0,
  stdout: '{"state":"OPEN","mergeable":"MERGEABLE","headRefName":"bot/dev/step_1"}',
  stderr: "",
  timedOut: false,
}

interface Call {
  readonly argv: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
}

// Records what each call would have run with; never spawns gh.
const recording = () => {
  const calls: Array<Call> = []
  const run: GhRun = (op, argv, env) => {
    calls.push({ argv, env: { ...env } })
    return Effect.succeed(op === "gh pr create" ? PR_OUT : VIEW_OUT)
  }
  return { calls, run }
}

const TOKEN = "ghs_installation_secret"
const tokens = (installationId: number) => Effect.succeed(`ghs_${installationId}_${TOKEN}`)
const CTX = { env: { HOME: "/tank/dev/home", PATH: "/bin" }, cwd: "/tank/dev/work/step" }
const OPTS = { title: "Add sum", body: "Closes #1", base: "main" }

describe("GhClient auth", () => {
  it.effect("the default auth is the Bot's own gh login: no GH_TOKEN, as before", () =>
    Effect.gen(function* () {
      const rec = recording()
      yield* makeGhClient(rec.run, {}).prCreate(CTX, OPTS)
      expect(rec.calls[0]?.env).toEqual(CTX.env)
    }),
  )

  it.effect("an installation auth puts its token in GH_TOKEN of that call and never in argv", () =>
    Effect.gen(function* () {
      const rec = recording()
      const pr = yield* makeGhClient(rec.run, {}, tokens).prCreate(CTX, OPTS, { installationId: 42 })
      expect(pr).toEqual({ url: "https://github.com/renzer83/shoalwork-sandbox/pull/5", number: 5 })
      expect(rec.calls[0]?.env).toEqual({ ...CTX.env, GH_TOKEN: `ghs_42_${TOKEN}` })
      expect(JSON.stringify(rec.calls[0]?.argv)).not.toContain(TOKEN)
    }),
  )

  it.effect("host calls with an installation auth take the host env plus GH_TOKEN", () =>
    Effect.gen(function* () {
      const rec = recording()
      const pr = yield* makeGhClient(rec.run, { PATH: "/bin", HOME: "/host" }, tokens).prView("a/b", 5, {
        installationId: 7,
      })
      expect(pr).toEqual({ state: "OPEN", mergeable: "MERGEABLE", headRef: "bot/dev/step_1" })
      expect(rec.calls[0]?.env).toEqual({ PATH: "/bin", HOME: "/host", GH_TOKEN: `ghs_7_${TOKEN}` })
    }),
  )

  it.effect("an installation auth without a token provider fails as GhError and runs nothing", () =>
    Effect.gen(function* () {
      const rec = recording()
      const failure = yield* Effect.flip(
        makeGhClient(rec.run, {}).prCreate(CTX, OPTS, { installationId: 42 }),
      )
      expect(failure).toBeInstanceOf(GhError)
      expect(failure.message).toContain("installation token")
      expect(rec.calls).toEqual([])
    }),
  )

  it.effect("a token provider failure reaches the caller as GhError, and the call does not run", () =>
    Effect.gen(function* () {
      const rec = recording()
      const broken = (): Effect.Effect<string, GhError> =>
        Effect.fail(new GhError({ op: "gh pr create", message: "installation token unavailable" }))
      const failure = yield* Effect.flip(
        makeGhClient(rec.run, {}, broken).prCreate(CTX, OPTS, { installationId: 42 }),
      )
      expect(failure.message).toBe("installation token unavailable")
      expect(rec.calls).toEqual([])
    }),
  )
})
