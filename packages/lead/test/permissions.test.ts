import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import { BeaconTest } from "@shoalwork/beacon"
import { BotId, ExecutorId, ExecutorTask, PolicyRule, StepId, TaskId } from "@shoalwork/contracts"
import type { ExecutorContext } from "@shoalwork/executors"
import { REEF_MCP_TOOLS } from "@shoalwork/executors"
import { makePolicyTest } from "@shoalwork/policy"
import { Effect, Layer, Schema } from "effect"
import { describe, expect } from "vitest"
import { derivePermission, permissionOf, startedPayload, toClaudeRule } from "../src/permissions.js"
import {
  allEvents,
  createBot,
  eventsOf,
  fakeExecutor,
  Lead,
  leadLayer,
  makeFakeTank,
  OK_EVENTS,
  type Runs,
  specFor,
} from "./support.js"

const BOT = Schema.decodeUnknownSync(BotId)("bot_3f2a9c1e-7b4d-4e8a-9f10-2c6d5e8b7a41")
const OTHER = Schema.decodeUnknownSync(BotId)("bot_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d")
const TASK = Schema.decodeUnknownSync(TaskId)("task_00000000-0000-4000-8000-000000000001")
const STEP = Schema.decodeUnknownSync(StepId)("step_00000000-0000-4000-8000-000000000002")
const CLAUDE = Schema.decodeUnknownSync(ExecutorId)("claude-code")
const CODEX = Schema.decodeUnknownSync(ExecutorId)("codex")

const rule = (input: Record<string, unknown>): PolicyRule => Schema.decodeUnknownSync(PolicyRule)(input)
const allow = (tool: string, extra: Record<string, unknown> = {}) =>
  rule({ bot: "*", tool, effect: "allow", ...extra })

describe("derivePermission", () => {
  it("pre-approves nothing for a policy without allow rules", () => {
    const rules = [
      rule({ bot: "*", tool: "Read(.env*)", effect: "deny" }),
      rule({ bot: "*", tool: "Bash(git push *)", effect: "ask" }),
    ]
    expect(derivePermission({ id: BOT }, rules)).toEqual({ permissionMode: "edit", allowedTools: [] })
    expect(derivePermission({ id: BOT }, [])).toEqual({ permissionMode: "edit", allowedTools: [] })
  })

  it("keeps the exact Bash rules and the plain tool names nothing restricts; drops wildcard rules", () => {
    const rules = [
      allow("Grep"),
      allow("Bash(pnpm test)"),
      allow("Bash(pnpm test *)"), // a wildcard has no derived form (T-166 probe pending)
      rule({ bot: "*", tool: "Read(.env*)", effect: "deny" }),
      rule({ bot: "*", tool: "Bash(rm * /)", effect: "deny" }),
      rule({ bot: "*", tool: "Bash(git push *)", effect: "ask" }),
    ]
    expect(derivePermission({ id: BOT }, rules).allowedTools).toEqual(["Grep", "Bash(pnpm test)"])
  })

  it("leaves out an allow that a deny or ask could cover, and one with a resource glob", () => {
    const rules = [
      allow("Read"), // a deny on Read(.env*) covers the tool name
      allow("Bash(git status)"), // an ask on git push shares the head
      allow("Edit", { resource: "src/**" }), // resource globs have no exact Claude Code form
      rule({ bot: "*", tool: "Read(.env*)", effect: "deny" }),
      rule({ bot: "*", tool: "Bash(git push *)", effect: "ask" }),
    ]
    expect(derivePermission({ id: BOT }, rules).allowedTools).toEqual([])
  })

  it("only applies rules of this Bot or of every Bot", () => {
    const rules = [allow("Grep", { bot: OTHER }), allow("Glob")]
    expect(derivePermission({ id: BOT }, rules).allowedTools).toEqual(["Glob"])
    expect(derivePermission({ id: OTHER }, rules).allowedTools).toEqual(["Grep", "Glob"])
  })
})

describe("toClaudeRule", () => {
  it.each([
    ["Read", "Read"],
    ["Bash(npm test)", "Bash(npm test)"],
    ["Bash(pnpm test)", "Bash(pnpm test)"],
    ["Bash(git status)", "Bash(git status)"],
  ])("maps %s to %s", (tool, expected) => {
    expect(toClaudeRule(rule({ bot: "*", tool, effect: "allow" }))).toBe(expected)
  })

  it.each([
    "*Edit",
    "Bash(npm test *)", // not derived: how the CLI matches a wildcard is not verified
    "Bash(pnpm test:*)",
    "Bash(pnpm * test)",
    "Bash(pnpm *)",
    "Bash(git *)",
    "Bash(git diff *)",
    "Bash(git log *)",
    "Bash(git show *)",
    "Bash(git status *)",
    "Bash(*)",
    "Bash(echo a;rm)",
    "Bash(echo $(id))",
    "mcp__x__*",
  ])("refuses %s, which is not an exact form", (tool) => {
    expect(toClaudeRule(rule({ bot: "*", tool, effect: "allow" }))).toBeUndefined()
  })

  it("refuses an allow with a resource", () => {
    expect(toClaudeRule(allow("Read", { resource: "src/**" }))).toBeUndefined()
  })
})

describe("the shipped default policy (T-057)", () => {
  const SHIPPED = readFileSync(new URL("../../../config/policies/default.yaml", import.meta.url), "utf8")
  // The allows the base policy names. Only the exact ones can be pre-approved; the rest stay with the Policy.
  const NAMED = [
    "Read",
    "Glob",
    "Grep",
    "Bash(pnpm test *)",
    "Bash(pnpm lint *)",
    "Bash(pnpm typecheck *)",
    "Bash(pnpm build *)",
    "Bash(git status)",
    "Bash(git diff *)",
  ]

  it.effect("pre-approves nothing: each named allow is overlapped by a deny or ask of the same policy", () =>
    Effect.gen(function* () {
      expect(yield* permissionOf({ id: BOT })).toEqual({ permissionMode: "edit", allowedTools: [] })
    }).pipe(
      Effect.provide(
        makePolicyTest({ sources: { default: SHIPPED }, policyOf: () => "default" }).pipe(
          Layer.provideMerge(BeaconTest),
        ),
      ),
    ),
  )

  it("derives only the exact named allows when nothing restricts them", () => {
    const rules = NAMED.map((tool) => allow(tool))
    expect(derivePermission({ id: BOT }, rules).allowedTools).toEqual([
      "Read",
      "Glob",
      "Grep",
      "Bash(git status)",
    ])
  })
})

describe("executor.started audit payload (T-057)", () => {
  const task = Schema.decodeUnknownSync(ExecutorTask)({
    taskId: TASK,
    botId: BOT,
    prompt: "do it",
    tier: "light",
    allowedTools: ["Bash(npm test)"],
    permissionMode: "edit",
    maxTurns: 5,
    budget: { tokens: 1000, seconds: 60, usd: 1 },
  })
  const context: ExecutorContext = {
    botId: BOT,
    botName: "dev",
    cwd: "/work/tree",
    home: "/work/home",
    env: {},
  }
  const withMcp: ExecutorContext = {
    ...context,
    mcp: { serverEntry: "/srv/reef.js", repo: "repo", bot: "dev", api: "http://127.0.0.1:1" },
  }
  const payload = (executor: ExecutorId, ctx: ExecutorContext) =>
    startedPayload({
      spec: { id: TASK },
      bot: { id: BOT },
      stepId: STEP,
      executor,
      model: "m",
      task,
      context: ctx,
    })

  it("lists what the Claude Code run gets, reef tools included when an MCP config is attached", () => {
    expect(payload(CLAUDE, withMcp)).toMatchObject({
      taskId: TASK,
      botId: BOT,
      executor: CLAUDE,
      cwd: "/work/tree",
      permissionMode: "edit",
      allowedTools: ["Bash(npm test)", ...REEF_MCP_TOOLS],
    })
  })

  it("lists only the task's tools without an MCP config", () => {
    expect(payload(CLAUDE, context).allowedTools).toEqual(["Bash(npm test)"])
  })

  it("does not add the reef tools for an executor that does not take them", () => {
    expect(payload(CODEX, withMcp).allowedTools).toEqual(["Bash(npm test)"])
  })
})

describe("a child policy's allow reaches the run (T-057, end to end)", () => {
  const SHIPPED = readFileSync(new URL("../../../config/policies/default.yaml", import.meta.url), "utf8")
  const CHILD = `extends: default\nrules:\n  - { bot: "*", tool: "Bash(npm test)", effect: allow }\n`

  it.effect("the executor.started event and the ExecutorTask carry Bash(npm test)", () => {
    const runs: Runs = []
    const tank = makeFakeTank()
    const layer = Layer.provideMerge(
      makePolicyTest({ sources: { default: SHIPPED, dev: CHILD }, policyOf: () => "dev" }),
      leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS), runs), tank }),
    )
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot))
      yield* lead.runOnce(spec.id)
      const started = (yield* allEvents).find((event) => event.type === "executor.started")
      expect(started?.payload).toMatchObject({ permissionMode: "edit", allowedTools: ["Bash(npm test)"] })
      expect(runs[0]?.allowedTools).toEqual(["Bash(npm test)"])
    }).pipe(Effect.provide(layer))
  })
})
