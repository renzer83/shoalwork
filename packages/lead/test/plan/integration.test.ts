import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { BotRegistry } from "@shoalwork/bots"
import { type Bot, newStepId, newTaskId, type TaskSpec } from "@shoalwork/contracts"
import { GhClientTest } from "@shoalwork/currents"
import { makeTankLocal, slugRepoUrl, type TankContext, type TankShape } from "@shoalwork/tank"
import { Effect } from "effect"
import { afterAll, describe, expect } from "vitest"
import { type IntegrationSession, makeIntegration, planBranchOf } from "../../src/plan/integration.js"
import { newBot } from "../conversation-support.js"
import { createBot, specFor } from "../support.js"
import { DispatchLayer } from "./dispatch-support.js"

const root = realpathSync(mkdtempSync(join(tmpdir(), "plan-integration-")))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const IDENTITY = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
}
const git = (cwd: string, ...args: Array<string>): string =>
  execFileSync("git", args, { cwd, env: { ...process.env, ...IDENTITY }, encoding: "utf8" })

const BASE_FILE = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n")

// A bare origin whose main has README.txt and a 12-line shared.txt.
const origin = join(root, "origin.git")
const seed = join(root, "seed")
mkdirSync(seed, { recursive: true })
git(root, "init", "--bare", "-b", "main", origin)
git(seed, "init", "-b", "main")
git(seed, "remote", "add", "origin", origin)
writeFileSync(join(seed, "README.txt"), "readme\n")
writeFileSync(join(seed, "shared.txt"), `${BASE_FILE}\n`)
git(seed, "add", ".")
git(seed, "commit", "-m", "init")
git(seed, "push", "origin", "main")

const tank: TankShape = makeTankLocal({
  root: join(root, "tanks"),
  baseEnv: { PATH: process.env.PATH, HOME: process.env.HOME },
})

const repo = { url: origin, base: "main" } as const

const identityArgs = (bot: Bot) => [
  "git",
  "-c",
  `user.name=${bot.name}`,
  "-c",
  `user.email=${bot.name}@bots.shoalwork.invalid`,
]

// Does what a plan step does in production: its own worktree off the base, one commit, pushed to origin.
const pushStep = (bot: Bot, title: string, file: string, edit: (current: string) => string) =>
  Effect.gen(function* () {
    const ctx: TankContext = yield* tank.prepare(bot, { stepId: newStepId(), repo })
    const current = yield* tank.readFile(ctx, file).pipe(Effect.orElseSucceed(() => ""))
    yield* tank.writeFile(ctx, file, edit(current))
    yield* tank.exec(ctx, ["git", "add", "-A"])
    yield* tank.exec(ctx, [...identityArgs(bot), "commit", `--message=${title}`])
    const branch = ctx.worktree?.branch ?? ""
    const pushed = yield* tank.exec(ctx, ["git", "push", "-u", "origin", branch])
    expect(pushed.exitCode).toBe(0)
    yield* tank.release(ctx, { keepWorktree: false })
    return { stepId: newStepId(), title, branch }
  })

const editLine = (n: number, text: string) => (current: string) =>
  current
    .split("\n")
    .map((line, i) => (i === n - 1 ? text : line))
    .join("\n")

const setup = Effect.gen(function* () {
  const registry = yield* BotRegistry
  const lead = yield* createBot
  const worker = yield* registry.upsert(newBot("worker-one", "developer", "fixed"), "test")
  const rootSpec: TaskSpec = { ...specFor(lead, { kind: "code", repo }), id: newTaskId() }
  const gh = GhClientTest()
  const integration = makeIntegration({ tank, gh: gh.shape, bots: registry })
  return { lead, worker, rootSpec, integration, gh }
})

const remoteBranches = (pattern: string): string => git(origin, "branch", "--list", pattern).trim()

describe("plan integration (real git, real Tank)", () => {
  it.live(
    "merges steps into the plan branch, flags overlapping files, and serializes concurrent merges",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { worker, rootSpec, integration, gh } = yield* setup
          const one = yield* pushStep(worker, "edit top", "shared.txt", editLine(1, "top by one"))
          const two = yield* pushStep(worker, "edit bottom", "shared.txt", editLine(12, "bottom by two"))
          const three = yield* pushStep(worker, "add file", "extra.txt", () => "extra\n")
          const session: IntegrationSession = yield* integration.open(rootSpec)
          expect(session.branch).toBe(planBranchOf(rootSpec.id))

          // Merged at the same time, they still go in one at a time: both succeed, nothing is corrupted.
          const results = yield* Effect.all([session.merge(one), session.merge(two), session.merge(three)], {
            concurrency: "unbounded",
          })

          expect(results.every((r) => r._tag === "Merged")).toBe(true)
          const overlapped = results.filter((r) => r._tag === "Merged" && r.serialized)
          // Exactly one of the two shared.txt steps arrived second and was serialized behind the other.
          expect(overlapped).toHaveLength(1)
          expect(overlapped[0]).toMatchObject({ overlap: ["shared.txt"] })

          yield* session.publish
          expect(yield* session.isPublished).toBe(true)
          expect(remoteBranches("plan/*")).toContain(session.branch)
          const merges = git(origin, "rev-list", "--merges", "--count", session.branch).trim()
          expect(merges).toBe("3")
          const shared = git(origin, "show", `${session.branch}:shared.txt`)
          expect(shared).toContain("top by one")
          expect(shared).toContain("bottom by two")

          const pr = yield* session.openPr
          expect(pr.kind).toBe("pr")
          expect(gh.calls.length).toBeGreaterThan(0)
        }),
      ).pipe(Effect.provide(DispatchLayer)),
  )

  it.live(
    "reports a conflicting step, leaves the plan worktree clean, and removes the worktree with the scope",
    () =>
      Effect.gen(function* () {
        const { lead, worker, rootSpec, integration } = yield* setup
        yield* Effect.scoped(
          Effect.gen(function* () {
            const one = yield* pushStep(worker, "left", "README.txt", () => "left\n")
            const two = yield* pushStep(worker, "right", "README.txt", () => "right\n")
            const session = yield* integration.open(rootSpec)
            expect((yield* session.merge(one))._tag).toBe("Merged")
            const second = yield* session.merge(two)
            expect(second).toEqual({ _tag: "Conflict", files: ["README.txt"] })
            // The aborted merge left nothing behind: a later, unrelated step still merges.
            const three = yield* pushStep(worker, "later", "later.txt", () => "later\n")
            expect((yield* session.merge(three))._tag).toBe("Merged")
          }),
        )
        expect(yield* tank.worktrees(lead, origin)).toEqual([])
      }).pipe(Effect.provide(DispatchLayer)),
  )

  it.live(
    "the local plan branch goes away with the scope; reopening the same task continues from origin",
    () =>
      Effect.gen(function* () {
        const { lead, worker, rootSpec, integration } = yield* setup
        const repoDir = join(root, "tanks", lead.name, "repos", slugRepoUrl(origin))
        const branch = planBranchOf(rootSpec.id)
        const first = yield* pushStep(worker, "first", "reopen-1.txt", () => "1\n")
        yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* integration.open(rootSpec)
            expect((yield* session.merge(first))._tag).toBe("Merged")
            yield* session.publish
          }),
        )
        expect(git(repoDir, "branch", "--list", "plan/*").trim()).toBe("")

        const second = yield* pushStep(worker, "second", "reopen-2.txt", () => "2\n")
        yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* integration.open(rootSpec)
            expect(yield* session.isPublished).toBe(true)
            expect((yield* session.merge(second))._tag).toBe("Merged")
            yield* session.publish
          }),
        )
        expect(git(origin, "ls-tree", "--name-only", branch).split("\n")).toEqual(
          expect.arrayContaining(["reopen-1.txt", "reopen-2.txt"]),
        )
        expect(git(origin, "rev-list", "--merges", "--count", branch).trim()).toBe("2")
        expect(git(repoDir, "branch", "--list", "plan/*").trim()).toBe("")
      }).pipe(Effect.provide(DispatchLayer)),
  )

  it.live("a stale local plan branch left by a crash is reset, not a failure", () =>
    Effect.gen(function* () {
      const { lead, rootSpec, integration } = yield* setup
      const repoDir = join(root, "tanks", lead.name, "repos", slugRepoUrl(origin))
      const fresh: TaskSpec = { ...rootSpec, id: newTaskId() }
      // Opening once makes sure the Bot's clone exists, whatever order the tests run in.
      yield* Effect.scoped(integration.open(rootSpec))
      git(repoDir, "branch", planBranchOf(fresh.id), "origin/main")
      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* integration.open(fresh)
          expect(session.branch).toBe(planBranchOf(fresh.id))
          expect(yield* session.isPublished).toBe(false)
        }),
      )
    }).pipe(Effect.provide(DispatchLayer)),
  )
})
