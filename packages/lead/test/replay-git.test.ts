import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import type { ExecutorEvent } from "@shoalwork/contracts"
import type { Executor } from "@shoalwork/executors"
import { TankLocalLive } from "@shoalwork/tank"
import { Effect, Stream } from "effect"
import { afterAll, describe, expect } from "vitest"
import { Lead, replay, streamEvents } from "./replay-support.js"
import { CLAUDE, createBot, leadLayer, SESSION, specFor, USAGE_EVENT } from "./support.js"

const IDENTITY = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
}
const env = { ...process.env, ...IDENTITY }
const git = (cwd: string, ...args: Array<string>): string =>
  execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()

const root = realpathSync(mkdtempSync(join(tmpdir(), "shoalwork-replay-git-")))
afterAll(() => rmSync(root, { recursive: true, force: true }))

// A bare origin with one commit on main, and a seed clone to add more.
const origin = join(root, "origin.git")
const seed = join(root, "seed")
mkdirSync(seed)
git(root, "init", "--bare", "-b", "main", origin)
git(seed, "init", "-b", "main")
git(seed, "remote", "add", "origin", origin)
const commit = (file: string): string => {
  writeFileSync(join(seed, file), `${file}\n`)
  git(seed, "add", file)
  git(seed, "commit", "-m", `add ${file}`)
  git(seed, "push", "origin", "main")
  return git(seed, "rev-parse", "HEAD")
}
const FIRST = commit("one.txt")

// The executor reads the HEAD it is given and edits a file, so the source run has something to deliver.
const heads: Array<string> = []
const executor: Executor = {
  id: CLAUDE,
  run: (_task, ctx) =>
    Stream.suspend(() => {
      heads.push(git(ctx.cwd, "rev-parse", "HEAD"))
      writeFileSync(join(ctx.cwd, `work-${heads.length}.txt`), "work\n")
      const events: ReadonlyArray<ExecutorEvent> = [
        { kind: "started", sessionId: SESSION },
        { kind: "file_edit", path: `work-${heads.length}.txt` },
        USAGE_EVENT,
        { kind: "done", result: "done", artifacts: [] },
      ]
      return Stream.fromIterable(events)
    }),
  mapTier: () => ({ model: "fake-model" }),
  quota: () => Effect.succeed({ executor: CLAUDE, usedRatio: 0, available: true }),
}

describe("replay over a real git repository", () => {
  it.live("starts from the source's commit, not the new tip, and pushes nothing", () =>
    Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const repo = { url: origin, base: "main" }
      const source = yield* lead.intake(specFor(bot, { repo }))
      yield* lead.runOnce(source.id)
      expect(heads).toEqual([FIRST])
      // The source delivered: its branch is on the origin.
      const branches = () =>
        git(origin, "branch", "--list", "bot/*")
          .split("\n")
          .filter((line) => line !== "")
      expect(branches()).toHaveLength(1)

      // main moves on: a plain new worktree would now start at SECOND.
      const second = commit("two.txt")
      expect(second).not.toBe(FIRST)

      const started = yield* (yield* replay).run(source.id)
      expect(started.baseSha).toBe(FIRST)
      yield* lead.runOnce(started.task.id)

      expect(heads).toEqual([FIRST, FIRST])
      const payload = (yield* streamEvents(started.task.id)).find(
        (event) => event.type === "executor.started",
      )?.payload
      expect(payload).toMatchObject({ baseSha: FIRST })
      // Nothing was pushed for the replay.
      expect(branches()).toHaveLength(1)
      const comparison = yield* (yield* replay).compare(started.replayId)
      expect(comparison.notes.join(" ")).toContain("Delivery skipped")
      expect(comparison.replay.evidence).toEqual([])
      expect(comparison.source.files).toEqual(["work-1.txt"])
      expect(comparison.replay.files).toEqual(["work-2.txt"])
    }).pipe(
      Effect.provide(
        leadLayer({
          executor,
          tankLayer: TankLocalLive({
            root: join(root, "tanks"),
            baseEnv: { PATH: process.env.PATH ?? "", ...IDENTITY },
          }),
          liveBeacon: true,
          config: { botBudgetWindowMs: 3_600_000 },
        }),
      ),
    ),
  )
})
