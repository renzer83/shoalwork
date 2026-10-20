import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { issueViewArgv, prCreateArgv, prMergeArgv, prViewArgv } from "../../src/github/gh.js"
import {
  checksVerdict,
  GhClient,
  GhClientTest,
  GhError,
  type GhOutput,
  type GhRun,
  hostGhEnv,
  makeGhClient,
  prChecksArgv,
  pullRequestFromOutput,
} from "../../src/index.js"

const ok = (stdout = "", stderr = ""): GhOutput => ({ exitCode: 0, stdout, stderr, timedOut: false })
const exit = (exitCode: number, stderr = "", stdout = ""): GhOutput => ({
  exitCode,
  stdout,
  stderr,
  timedOut: false,
})

// A scripted process: records argv, env and cwd of each call and answers with the given output.
const scripted = (answer: (argv: ReadonlyArray<string>) => GhOutput) => {
  const calls: Array<{
    argv: ReadonlyArray<string>
    env: Readonly<Record<string, string>>
    cwd: string | undefined
  }> = []
  const run: GhRun = (_op, argv, env, cwd) => {
    calls.push({ argv, env, cwd })
    return Effect.succeed(answer(argv))
  }
  return { calls, run }
}

const HOST_ENV = { PATH: "/usr/bin", HOME: "/home/core" }
const BOT_CTX = { env: { HOME: "/tank/dev-demo/home", PATH: "/usr/bin" }, cwd: "/tank/dev-demo/work/step" }
const CHECKS_PASS = JSON.stringify([
  { bucket: "pass", state: "SUCCESS" },
  { bucket: "skipping", state: "SKIPPED" },
])
const CHECKS_PENDING = JSON.stringify([
  { bucket: "pass", state: "SUCCESS" },
  { bucket: "pending", state: "IN_PROGRESS" },
])
const CHECKS_FAIL = JSON.stringify([
  { bucket: "fail", state: "FAILURE" },
  { bucket: "pending", state: "PENDING" },
])

describe("argv builders", () => {
  it("place every number after -- and free text as an attached flag value", () => {
    expect(issueViewArgv("renzer83/shoalwork", 3)).toEqual([
      "gh",
      "issue",
      "view",
      "--repo",
      "renzer83/shoalwork",
      "--json",
      "title,body,labels",
      "--",
      "3",
    ])
    expect(prViewArgv("a/b", 7)).toEqual([
      "gh",
      "pr",
      "view",
      "--repo",
      "a/b",
      "--json",
      "state,mergeable,headRefName",
      "--",
      "7",
    ])
    expect(prMergeArgv("a/b", 7, { auto: true, deleteBranch: true })).toEqual([
      "gh",
      "pr",
      "merge",
      "--repo",
      "a/b",
      "--squash",
      "--auto",
      "--delete-branch",
      "--",
      "7",
    ])
    expect(prChecksArgv("a/b", 7)).toEqual([
      "gh",
      "pr",
      "checks",
      "--repo",
      "a/b",
      "--json",
      "bucket,state",
      "--",
      "7",
    ])
  })

  it("keeps a title or body that starts with a dash as the value of its flag", () => {
    const argv = prCreateArgv({ title: "--no-verify", body: "--help", base: "-main" })
    expect(argv).toEqual(["gh", "pr", "create", "--title=--no-verify", "--body=--help", "--base=-main"])
  })

  it("reads the PR URL and number from gh output lines", () => {
    expect(pullRequestFromOutput("warning: x\nhttps://github.com/a/b/pull/12\n")).toEqual({
      url: "https://github.com/a/b/pull/12",
      number: 12,
    })
    expect(pullRequestFromOutput("created something else")).toBeUndefined()
  })
})

describe("checksVerdict", () => {
  it("fails on any failed check, pends while one runs or none exist, passes otherwise", () => {
    expect(checksVerdict([{ bucket: "pass", state: "SUCCESS" }])).toBe("pass")
    expect(checksVerdict([{ bucket: "skipping", state: "SKIPPED" }])).toBe("pass")
    expect(
      checksVerdict([
        { bucket: "pass", state: "SUCCESS" },
        { bucket: "pending", state: "QUEUED" },
      ]),
    ).toBe("pending")
    expect(checksVerdict([])).toBe("pending")
    expect(
      checksVerdict([
        { bucket: "pending", state: "PENDING" },
        { bucket: "fail", state: "FAILURE" },
      ]),
    ).toBe("fail")
    expect(checksVerdict([{ bucket: "cancel", state: "CANCELLED" }])).toBe("fail")
  })
})

describe("makeGhClient", () => {
  it.effect("prCreate runs in the Bot's env and worktree, never the host env", () => {
    const { calls, run } = scripted(() => ok("https://github.com/a/b/pull/9\n"))
    const client = makeGhClient(run, hostGhEnv(HOST_ENV))
    return Effect.gen(function* () {
      const pr = yield* client.prCreate(BOT_CTX, { title: "T", body: "B", base: "main" })
      expect(pr).toEqual({ url: "https://github.com/a/b/pull/9", number: 9 })
      expect(calls[0]?.env).toEqual(BOT_CTX.env)
      expect(calls[0]?.cwd).toBe(BOT_CTX.cwd)
      expect(calls[0]?.argv).toEqual(["gh", "pr", "create", "--title=T", "--body=B", "--base=main"])
    })
  })

  it.effect("prCreate fails when gh prints no PR URL", () => {
    const { run } = scripted(() => ok("done"))
    const client = makeGhClient(run, {})
    return Effect.gen(function* () {
      const failure = yield* Effect.flip(client.prCreate(BOT_CTX, { title: "T", body: "B", base: "main" }))
      expect(failure).toBeInstanceOf(GhError)
      expect(failure.message).toBe("gh printed no pull request URL")
    })
  })

  it.effect("a non-zero exit is a GhError with the first stderr line only, credentials redacted", () => {
    const { run } = scripted(() =>
      exit(1, "fatal: https://bot:fixture-credential@github.com/a/b\nSECRET-SECOND-LINE"),
    )
    const client = makeGhClient(run, {})
    return Effect.gen(function* () {
      const failure = yield* Effect.flip(client.prView("a/b", 1))
      expect(failure.message).toBe("gh pr view exited 1: fatal: https://***@github.com/a/b")
      expect(failure.message).not.toContain("fixture-credential")
      expect(failure.message).not.toContain("SECRET-SECOND-LINE")
    })
  })

  it.effect("prChecks decides from the checks JSON: pass, pending and fail", () => {
    const checksWith = (stdout: string, code: number) =>
      makeGhClient(() => Effect.succeed(exit(code, "", stdout)), {}).prChecks("a/b", 7, {
        watch: false,
        timeoutMs: 1,
      })
    return Effect.gen(function* () {
      expect(yield* checksWith(CHECKS_PASS, 0)).toBe("pass")
      expect(yield* checksWith(CHECKS_PENDING, 8)).toBe("pending")
      expect(yield* checksWith(CHECKS_FAIL, 1)).toBe("fail")
    })
  })

  it.effect("prChecks without valid JSON is a GhError, whatever the exit code", () => {
    const at = (code: number, stdout: string, stderr = "") =>
      makeGhClient(() => Effect.succeed(exit(code, stderr, stdout)), {}).prChecks("a/b", 7, {
        watch: false,
        timeoutMs: 1,
      })
    return Effect.gen(function* () {
      expect(yield* Effect.flip(at(0, "not json"))).toMatchObject({
        message: "gh pr checks printed unexpected output",
      })
      expect(yield* Effect.flip(at(4, "", "no auth"))).toMatchObject({
        message: "gh pr checks exited 4: no auth",
      })
    })
  })

  it.live(
    "prChecks in watch mode polls until the checks are decided",
    () => {
      let calls = 0
      const client = makeGhClient(() => {
        calls += 1
        return Effect.succeed(exit(calls === 1 ? 8 : 0, "", calls === 1 ? CHECKS_PENDING : CHECKS_PASS))
      }, {})
      return Effect.gen(function* () {
        expect(yield* client.prChecks("a/b", 7, { watch: true, timeoutMs: 60_000 })).toBe("pass")
        expect(calls).toBe(2)
      })
    },
    20_000,
  )

  it.effect("a timed out call is a GhError naming the timeout", () => {
    const { run } = scripted(() => ({ exitCode: -1, stdout: "", stderr: "", timedOut: true }))
    const client = makeGhClient(run, {})
    return Effect.gen(function* () {
      const failure = yield* Effect.flip(
        client.prMerge("a/b", 1, { squash: true, auto: false, deleteBranch: false }),
      )
      expect(failure.message).toBe("gh pr merge timed out")
    })
  })

  it.effect("issueView decodes title, body and label names", () => {
    const payload = JSON.stringify({ title: "Add sum", body: "text", labels: [{ name: "enhancement" }] })
    const { run } = scripted(() => ok(payload))
    const client = makeGhClient(run, {})
    return Effect.gen(function* () {
      expect(yield* client.issueView("a/b", 3)).toEqual({
        title: "Add sum",
        body: "text",
        labels: ["enhancement"],
      })
    })
  })

  it.effect("host calls carry only the allowlisted host env", () => {
    const { calls, run } = scripted(() =>
      ok('{"state":"OPEN","mergeable":"MERGEABLE","headRefName":"bot/x"}'),
    )
    const client = makeGhClient(
      run,
      hostGhEnv({
        PATH: "/usr/bin",
        HOME: "/home/core",
        TELEGRAM_BOT_TOKEN: "secret",
        GH_HOST: "github.com",
      }),
    )
    return Effect.gen(function* () {
      yield* client.prView("a/b", 1)
      expect(calls[0]?.env).toEqual({ PATH: "/usr/bin", HOME: "/home/core", GH_HOST: "github.com" })
    })
  })
})

describe("GhClientTest", () => {
  it.effect("records each call and answers from the replies", () => {
    const fake = GhClientTest({ prChecks: "pending" })
    return Effect.gen(function* () {
      const client = yield* GhClient
      expect(yield* client.prChecks("a/b", 2, { watch: false, timeoutMs: 1 })).toBe("pending")
      expect(fake.calls).toEqual([{ method: "prChecks", args: ["a/b", 2, { watch: false, timeoutMs: 1 }] }])
    }).pipe(Effect.provide(fake.layer))
  })
})
