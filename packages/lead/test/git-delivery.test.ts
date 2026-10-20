import { it } from "@effect/vitest"
import { BotId, RepoRef } from "@shoalwork/contracts"
import { GhClientTest, GhError, pullRequestFromOutput } from "@shoalwork/currents"
import type { ExecResult, TankContext } from "@shoalwork/tank"
import { Effect, Schema } from "effect"
import { describe, expect } from "vitest"
import { cleanText, DeliveryFailed, deliverCode, deliveryBody, deliveryTitle } from "../src/git-delivery.js"
import { Lead } from "../src/index.js"
import {
  createBot,
  eventsOf,
  fakeExecutor,
  HEALTHY_EXEC,
  leadLayer,
  makeFakeTank,
  OK_EVENTS,
  type Runs,
  specFor,
} from "./support.js"

const BOT_ID = Schema.decodeUnknownSync(BotId)("bot_00000000-0000-5000-8000-000000000001")
const BRANCH = "bot/dev-demo/step_00000000-0000-4000-8000-000000000002"
const REPO = { url: "https://github.com/renzer83/shoalwork-sandbox", base: "main", issue: 1 } as const

const worktreeCtx = (): TankContext => ({
  botId: BOT_ID,
  botName: "dev-demo",
  cwd: "/tank/dev-demo/work/step",
  home: "/tank/dev-demo/home",
  env: {},
  worktree: { path: "/tank/dev-demo/work/step", branch: BRANCH, repoDir: "/tank/dev-demo/repos/x" },
})

const TASK_ID = "task_00000000-0000-4000-8000-000000000003"

const result = (exitCode: number, stdout = "", stderr = ""): ExecResult => ({
  exitCode,
  stdout,
  stderr,
  durationMs: 1,
  timedOut: false,
})

const deliver = (
  title: string,
  exec: (argv: ReadonlyArray<string>) => ExecResult = HEALTHY_EXEC,
  gh = GhClientTest(),
) => {
  const tank = makeFakeTank({ exec })
  const effect = deliverCode(
    tank.shape,
    worktreeCtx(),
    { taskId: TASK_ID, title, base: "main", issue: 1 },
    gh.shape,
  )
  return { tank, gh, effect }
}

describe("delivery text filter", () => {
  it.effect("rejects every marker of the filter in titles, keeping the issue title otherwise", () =>
    Effect.sync(() => {
      for (const marker of ["Claude", "anthropic", "OpenAI", "codex", "AI-generated", "Co-Authored-By"]) {
        expect(cleanText(`Fix ${marker} parser`, "fallback")).toBe("fallback")
      }
      expect(cleanText("Add a function sum(a,b)", "fallback")).toBe("Add a function sum(a,b)")
    }),
  )

  it.effect("names the PR and commit after the issue, or a neutral title when that title names a tool", () =>
    Effect.sync(() => {
      expect(deliveryTitle("Add sum", 1)).toBe("Add sum")
      expect(deliveryTitle("Fix codex bug", 7)).toBe("Resolve issue #7")
      expect(deliveryTitle("Fix codex bug", undefined)).toBe("Bot change")
    }),
  )

  it.effect("PR body closes the issue, or names the task when there is no issue", () =>
    Effect.sync(() => {
      expect(deliveryBody(TASK_ID, 1)).toBe("Closes #1")
      expect(deliveryBody(TASK_ID, undefined)).toBe(`Task ${TASK_ID}`)
    }),
  )

  it.effect("finds the PR URL among gh output lines and reports none when absent", () =>
    Effect.sync(() => {
      expect(pullRequestFromOutput("warning: x\nhttps://github.com/a/b/pull/12\n")).toEqual({
        url: "https://github.com/a/b/pull/12",
        number: 12,
      })
      expect(pullRequestFromOutput("created something else")).toBeUndefined()
    }),
  )

  it.effect("RepoRef accepts an integer issue and rejects a fractional one", () =>
    Effect.sync(() => {
      expect(Schema.decodeUnknownSync(RepoRef)({ url: "https://x/y", base: "main", issue: 3 })).toEqual({
        url: "https://x/y",
        base: "main",
        issue: 3,
      })
      expect(() =>
        Schema.decodeUnknownSync(RepoRef)({ url: "https://x/y", base: "main", issue: 1.5 }),
      ).toThrow()
    }),
  )
})

describe("deliverCode", () => {
  it.effect(
    "runs add, commit and push as argv in the Bot's worktree, then opens the PR through GhClient",
    () => {
      const { tank, gh, effect } = deliver("Add sum")
      return Effect.gen(function* () {
        const artifact = yield* effect
        expect(artifact).toEqual({ kind: "pr", ref: "https://github.com/renzer83/shoalwork-sandbox/pull/1" })
        expect(gh.calls).toEqual([
          {
            method: "prCreate",
            args: ["/tank/dev-demo/work/step", { title: "Add sum", body: "Closes #1", base: "main" }],
          },
        ])
        expect(tank.commands).toEqual([
          ["git", "add", "-A"],
          ["git", "diff", "--cached", "--quiet"],
          [
            "git",
            "-c",
            "user.name=dev-demo",
            "-c",
            "user.email=dev-demo@bots.shoalwork.invalid",
            "commit",
            "--message=Add sum",
          ],
          ["git", "push", "-u", "origin", BRANCH],
        ])
      })
    },
  )

  it.effect("an unclean issue title never reaches the commit or the PR", () => {
    const { tank, gh, effect } = deliver("Fix Claude parser")
    return Effect.gen(function* () {
      yield* effect
      expect(gh.calls[0]?.args[1]).toEqual({ title: "Resolve issue #1", body: "Closes #1", base: "main" })
      expect(tank.commands).toContainEqual([
        "git",
        "-c",
        "user.name=dev-demo",
        "-c",
        "user.email=dev-demo@bots.shoalwork.invalid",
        "commit",
        "--message=Resolve issue #1",
      ])
      for (const argv of tank.commands) {
        expect(argv.join(" ")).not.toMatch(/claude/i)
      }
      expect(JSON.stringify(gh.calls)).not.toMatch(/claude/i)
    })
  })

  it.effect("a title that starts with a dash stays the value of its flag", () => {
    const { tank, effect } = deliver("--no-verify")
    return Effect.gen(function* () {
      yield* effect
      expect(tank.commands).toContainEqual([
        "git",
        "-c",
        "user.name=dev-demo",
        "-c",
        "user.email=dev-demo@bots.shoalwork.invalid",
        "commit",
        "--message=--no-verify",
      ])
    })
  })

  it.effect("refuses to deliver when nothing is staged, and commits nothing", () => {
    const { tank, effect } = deliver("Add sum", (argv) =>
      argv.slice(0, 2).join(" ") === "git diff" ? result(0) : HEALTHY_EXEC(argv),
    )
    return Effect.gen(function* () {
      const failure = yield* Effect.flip(effect)
      expect(failure).toBeInstanceOf(DeliveryFailed)
      expect(failure).toMatchObject({ step: "commit", message: "no changes" })
      expect(tank.commands.map((argv) => argv[1])).toEqual(["add", "diff"])
    })
  })

  it.effect("commits with the Bot's identity passed on the command line, not from its HOME", () => {
    const { tank, effect } = deliver("Add sum")
    return Effect.gen(function* () {
      yield* effect
      const commit = tank.commands.find((argv) => argv.includes("commit"))
      expect(commit).toEqual([
        "git",
        "-c",
        "user.name=dev-demo",
        "-c",
        "user.email=dev-demo@bots.shoalwork.invalid",
        "commit",
        "--message=Add sum",
      ])
    })
  })

  it.effect("a failed commit names the git command, not the identity options", () => {
    const { effect } = deliver("Add sum", (argv) =>
      argv.includes("commit") ? result(1, "", "Author identity unknown") : HEALTHY_EXEC(argv),
    )
    return Effect.gen(function* () {
      const failure = yield* Effect.flip(effect)
      expect(failure).toMatchObject({
        step: "commit",
        message: "git commit exited 1: Author identity unknown",
      })
    })
  })

  it.effect("a failed push is a DeliveryFailed at push, with stderr redacted of URL credentials", () => {
    const { effect } = deliver("Add sum", (argv) =>
      argv.slice(0, 2).join(" ") === "git push"
        ? result(1, "", "fatal: unable to access https://bot:fixture-credential@github.com/a/b\nmore")
        : HEALTHY_EXEC(argv),
    )
    return Effect.gen(function* () {
      const failure = yield* Effect.flip(effect)
      expect(failure).toMatchObject({ step: "push" })
      expect(failure.message).toBe("git push exited 1: fatal: unable to access https://***@github.com/a/b")
      expect(failure.message).not.toContain("fixture-credential")
    })
  })

  it.effect("a PR that GhClient cannot open fails at pr with its message", () => {
    const gh = GhClientTest()
    const refusing = {
      ...gh.shape,
      prCreate: () =>
        Effect.fail(new GhError({ op: "gh pr create", message: "gh printed no pull request URL" })),
    }
    const tank = makeFakeTank()
    const effect = deliverCode(
      tank.shape,
      worktreeCtx(),
      { taskId: TASK_ID, title: "Add sum", base: "main", issue: 1 },
      refusing,
    )
    return Effect.gen(function* () {
      const failure = yield* Effect.flip(effect)
      expect(failure).toMatchObject({ step: "pr", message: "gh printed no pull request URL" })
    })
  })

  it.effect("a timed out command is a failure of its step", () => {
    const { effect } = deliver("Add sum", (argv) =>
      argv.slice(0, 2).join(" ") === "git push" ? { ...result(-1), timedOut: true } : HEALTHY_EXEC(argv),
    )
    return Effect.gen(function* () {
      const failure = yield* Effect.flip(effect)
      expect(failure).toMatchObject({ step: "push", message: "git push timed out" })
    })
  })

  it.effect("without a worktree there is nothing to deliver", () => {
    const tank = makeFakeTank()
    const bare: TankContext = {
      botId: BOT_ID,
      botName: "dev-demo",
      cwd: "/tank/work",
      home: "/tank/home",
      env: {},
    }
    return Effect.gen(function* () {
      const failure = yield* Effect.flip(
        deliverCode(
          tank.shape,
          bare,
          { taskId: TASK_ID, title: "x", base: "main", issue: 1 },
          GhClientTest().shape,
        ),
      )
      expect(failure).toMatchObject({ step: "commit", message: "no worktree to deliver" })
      expect(tank.commands).toEqual([])
    })
  })
})

describe("Lead delivers code tasks after an ok run", () => {
  it.effect(
    "an ok code task with a repo ends ok, with the PR as evidence, and its worktree is removed",
    () => {
      const runs: Runs = []
      const tank = makeFakeTank()
      return Effect.gen(function* () {
        const lead = yield* Lead
        const bot = yield* createBot
        const spec = yield* lead.intake(specFor(bot, { repo: REPO }))
        const verdict = yield* lead.runOnce(spec.id)
        expect(verdict).toMatchObject({
          kind: "ok",
          evidence: ["https://github.com/renzer83/shoalwork-sandbox/pull/1"],
        })
        expect(tank.commands.map((argv) => argv[0])).toEqual(["git", "git", "git", "git"])
        expect(tank.released).toEqual([{ keepWorktree: false }])
        // T-057: the tool list comes from the Bot's policy; the test layer has no Policy, so nothing is pre-approved.
        expect(runs[0]?.allowedTools).toEqual([])
      }).pipe(Effect.provide(leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS), runs), tank })))
    },
  )

  it.effect("a failed delivery makes the verdict failed at that step and keeps the worktree", () => {
    const tank = makeFakeTank({
      exec: (argv) =>
        argv.slice(0, 2).join(" ") === "git push" ? result(1, "", "rejected") : HEALTHY_EXEC(argv),
    })
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot, { repo: REPO }))
      const verdict = yield* lead.runOnce(spec.id)
      expect(verdict).toMatchObject({ kind: "failed", evidence: ["delivery: push"] })
      expect(verdict.summary).toBe("delivery failed at push: git push exited 1: rejected")
      expect(tank.released).toEqual([{ keepWorktree: true }])
      expect((yield* lead.get(spec.id)).state).toBe("failed")
    }).pipe(Effect.provide(leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS)), tank })))
  })

  it.effect("a chat task with a repo is not delivered", () => {
    const tank = makeFakeTank()
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot, { kind: "chat", repo: REPO }))
      const verdict = yield* lead.runOnce(spec.id)
      expect(verdict.kind).toBe("ok")
      expect(tank.commands).toEqual([])
    }).pipe(Effect.provide(leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS)), tank })))
  })

  it.effect("a code task that did not finish ok is not delivered", () => {
    const tank = makeFakeTank()
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot, { repo: REPO }))
      const verdict = yield* lead.runOnce(spec.id)
      expect(verdict.kind).toBe("blocked")
      expect(tank.commands).toEqual([])
      // protocol is retryable: two runs, each keeps its worktree for the next one.
      expect(tank.released).toEqual([{ keepWorktree: true }, { keepWorktree: true }])
    }).pipe(
      Effect.provide(
        leadLayer({
          executor: fakeExecutor(eventsOf([{ kind: "error", code: "protocol", message: "broken" }])),
          tank,
        }),
      ),
    )
  })

  it.effect("a code task without a repo gets no tool allowlist and no delivery", () => {
    const runs: Runs = []
    const tank = makeFakeTank()
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot))
      yield* lead.runOnce(spec.id)
      expect(runs[0]?.allowedTools).toEqual([])
      expect(tank.commands).toEqual([])
    }).pipe(Effect.provide(leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS), runs), tank })))
  })
})
