import { type Bot, TankError, TaskSpec } from "@shoalwork/contracts"
import type { CodeSearchHit, Scored } from "@shoalwork/reef"
import type { TankContext } from "@shoalwork/tank"
import { Effect, Schema } from "effect"
import {
  type BriefingCode,
  type BriefingDeps,
  type BriefingMemory,
  buildBriefing,
} from "../../src/context/briefing.js"
import { type ContextConfig, DEFAULT_CONTEXT_CONFIG } from "../../src/context/config.js"
import { makeContextPlanner } from "../../src/context/planner.js"
import { bot, spec } from "./fixtures.js"

export const config = DEFAULT_CONTEXT_CONFIG
export const planner = makeContextPlanner(config)
export const repo = { url: "https://example.invalid/acme/demo.git", base: "main" }

export const withSpec = (patch: Record<string, unknown>) =>
  Schema.decodeUnknownSync(TaskSpec)({ ...Schema.encodeSync(TaskSpec)(spec), ...patch })

export const scratch: TankContext = { botId: bot.id, botName: bot.name, cwd: "/work", home: "/home", env: {} }
export const worktreeCtx: TankContext = {
  ...scratch,
  worktree: { path: "/work", branch: "bot/dev-demo/step", repoDir: "/repo" },
}

export const hit = (id: string, content: string, score = 0.5): Scored => ({
  id,
  scope: "bot",
  owner_id: bot.id,
  kind: "semantic",
  content,
  source: "user:renan",
  confidence: 1,
  created_at: "2026-10-20T00:00:00.000Z",
  superseded_by: null,
  tombstone: 0,
  score,
})

export const chunk = (path: string, content: string, score = 0.03): CodeSearchHit => ({
  id: path,
  path,
  startLine: 1,
  endLine: 9,
  lang: "ts",
  symbols: [],
  content,
  score,
  boosted: false,
})

// Answers every search with the given hits and records the call.
export const fixtureMemory = (hits: ReadonlyArray<Scored>) => {
  const calls: Array<{ readonly q: string; readonly opts: unknown }> = []
  const memory: BriefingMemory = {
    search: (q, opts) =>
      Effect.sync(() => {
        calls.push({ q, opts })
        return hits
      }),
  }
  return { memory, calls }
}

export const fixtureCode = (hits: ReadonlyArray<CodeSearchHit>) => {
  const calls: Array<{ readonly repo: string; readonly k: number }> = []
  const code: BriefingCode = (r, _q, k) =>
    Effect.sync(() => {
      calls.push({ repo: r.url, k })
      return hits
    })
  return { code, calls }
}

// A file that is not there fails like the local Tank's does.
export const absent = () =>
  new TankError({ op: "readFile", cause: Object.assign(new Error("no such file"), { code: "ENOENT" }) })

export const files = (contents: Record<string, string>): BriefingDeps["tank"] => ({
  readFile: (_ctx, rel) => {
    const text = contents[rel]
    return text === undefined ? Effect.fail(absent()) : Effect.succeed(text)
  },
})

export const deps = (parts: Partial<BriefingDeps> = {}): BriefingDeps => ({
  tank: files({}),
  onSourceError: () => Effect.void,
  ...parts,
})

export const buildFor = (
  theBot: Bot,
  task: TaskSpec,
  parts: Partial<BriefingDeps> = {},
  ctx: TankContext = scratch,
  decision = { complexity: 3 },
  using: ContextConfig = config,
) =>
  buildBriefing(deps(parts), {
    spec: task,
    bot: theBot,
    ctx,
    plan: makeContextPlanner(using).plan(task, decision),
    config: using,
  })

export const build = (
  task: TaskSpec,
  parts: Partial<BriefingDeps> = {},
  ctx: TankContext = scratch,
  decision = { complexity: 3 },
  using: ContextConfig = config,
) => buildFor(bot, task, parts, ctx, decision, using)
