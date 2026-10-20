import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import { BeaconTest } from "@shoalwork/beacon"
import { BotRegistry } from "@shoalwork/bots"
import {
  newStepId,
  newTaskId,
  type PolicyDecision,
  TankError,
  type TaskSpec,
  type ToolCall,
} from "@shoalwork/contracts"
import { makePolicyTest, Policy, type PolicyShape } from "@shoalwork/policy"
import { criterionRule } from "@shoalwork/reflex"
import type { ExecResult, TankShape } from "@shoalwork/tank"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { makeStepVerify, policyAllow, type VerifyInput } from "../../src/plan/step-verify.js"
import { createBot, makeFakeTank, specFor } from "../support.js"
import { DispatchLayer, okVerdict, step } from "./dispatch-support.js"

const exec = (exitCode: number, timedOut = false): ExecResult => ({
  exitCode,
  stdout: "",
  stderr: "",
  durationMs: 5,
  timedOut,
})

// A Policy that answers with a fixed effect and remembers what it was asked.
const policyOf = (effect: PolicyDecision["effect"]) => {
  const calls: Array<ToolCall> = []
  const policy: Pick<PolicyShape, "evaluate"> = {
    evaluate: (_botId, call) =>
      Effect.sync(() => {
        calls.push(call)
        return { effect, risk: "read" }
      }),
  }
  return { policy, calls }
}

const judge = ({ tests }: { readonly tests: "pass" | "fail" | "none" }) =>
  Effect.succeed(criterionRule(tests))

describe("policyAllow (check commands are the Bot's Bash)", () => {
  it.effect("without a Policy nothing is allowed", () =>
    Effect.gen(function* () {
      const bot = yield* createBot
      expect(yield* policyAllow(undefined)(bot.id, ["pnpm", "test"])).toBe("refused")
    }).pipe(Effect.provide(DispatchLayer)),
  )

  it.effect("asks the Policy for a Bash call with the argv joined; only allow passes", () =>
    Effect.gen(function* () {
      const bot = yield* createBot
      const yes = policyOf("allow")
      expect(yield* policyAllow(yes.policy)(bot.id, ["pnpm", "--filter", "@shoalwork/lead", "test"])).toBe(
        "allow",
      )
      expect(yes.calls).toEqual([{ tool: "Bash", input: { command: "pnpm --filter @shoalwork/lead test" } }])
      for (const effect of ["ask", "deny"] as const) {
        expect(yield* policyAllow(policyOf(effect).policy)(bot.id, ["pnpm", "test"])).toBe("refused")
      }
    }).pipe(Effect.provide(DispatchLayer)),
  )

  it.effect("a shape the Lead does not accept is refused without asking the Policy", () =>
    Effect.gen(function* () {
      const bot = yield* createBot
      const yes = policyOf("allow")
      const allow = policyAllow(yes.policy)
      for (const argv of [
        ["pnpm", "test;rm"],
        ["pnpm", "$(id)", "test"],
        ["pnpm", "test", "a b"],
        ["pnpm", "test", "`id`"],
        ["pnpm", ""],
        [],
      ]) {
        expect(yield* allow(bot.id, argv)).toBe("refused")
      }
      expect(yes.calls).toEqual([])
    }).pipe(Effect.provide(DispatchLayer)),
  )
})

// The product policy file, in memory: what the core runs with.
const DEFAULT_POLICY = readFileSync(
  new URL("../../../../config/policies/default.yaml", import.meta.url),
  "utf8",
)
const RealPolicy = makePolicyTest({ sources: { default: DEFAULT_POLICY }, policyOf: () => "default" })

describe("policyAllow with the product Policy", () => {
  it.effect("lets the plain test, lint, typecheck and build commands through", () =>
    Effect.gen(function* () {
      const bot = yield* createBot
      const allow = policyAllow(yield* Policy)
      for (const argv of [
        ["pnpm", "test"],
        ["pnpm", "--filter", "@shoalwork/lead", "test"],
        ["pnpm", "run", "lint"],
        ["npm", "run", "typecheck"],
        ["pnpm", "build"],
      ]) {
        expect(yield* allow(bot.id, argv)).toBe("allow")
      }
    }).pipe(Effect.provide(RealPolicy), Effect.provide(BeaconTest), Effect.provide(DispatchLayer)),
  )

  it.effect("refuses the ways to smuggle a command into a check, and never asks about them as allowed", () =>
    Effect.gen(function* () {
      const bot = yield* createBot
      const policy = yield* Policy
      const allow = policyAllow(policy)
      for (const argv of [
        ["pnpm", "test", "--"],
        ["pnpm", "-c", "test"],
        ["pnpm", "--config.x=1", "test"],
        ["pnpm", "-C", "/tmp", "test"],
        ["pnpm", "--dir", "..", "test"],
        ["pnpm", "--prefix", "/", "test"],
        ["node", "-e", "process.exit(0)"],
        ["pnpm", "exec", "node"],
        ["pnpm", "dlx", "cowsay"],
        ["git", "-c", "core.hooksPath=/tmp/h", "commit"],
        ["git", "status"],
      ]) {
        expect(yield* allow(bot.id, argv)).toBe("refused")
      }
    }).pipe(Effect.provide(RealPolicy), Effect.provide(BeaconTest), Effect.provide(DispatchLayer)),
  )
})

const KEPT = { repoDir: "/work/repo", path: "/work/wt", branch: `bot/worker-bot/${newStepId()}` }

const setup = (
  checks: ReadonlyArray<ReadonlyArray<string>>,
  over: {
    readonly allow?: "allow" | "refused"
    readonly answer?: (argv: ReadonlyArray<string>) => ExecResult
    readonly failPrepare?: boolean
    readonly kept?: boolean
    readonly repo?: boolean
  } = {},
) =>
  Effect.gen(function* () {
    const bot = yield* createBot
    const fake = makeFakeTank({ exec: over.answer ?? (() => exec(0)) })
    const branch = `bot/${bot.name}/${newStepId()}`
    const prepares: Array<Parameters<TankShape["prepare"]>[1]> = []
    // The real Tank continues a kept worktree on `reuse`; this one records what it was asked.
    const shape: TankShape = {
      ...fake.shape,
      worktrees: () => Effect.succeed(over.kept === false ? [] : [{ ...KEPT, branch }]),
      prepare: (forBot, request) =>
        Effect.suspend(() => {
          prepares.push(request)
          return over.failPrepare === true
            ? Effect.fail(new TankError({ op: "prepare", cause: "disk full" }))
            : Effect.succeed({
                botId: forBot.id,
                botName: forBot.name,
                cwd: KEPT.path,
                home: "/work/home",
                env: {},
              })
        }),
    }
    const asked: Array<ReadonlyArray<string>> = []
    const verify = makeStepVerify({
      tank: shape,
      bots: yield* BotRegistry,
      allow: (_botId, argv) =>
        Effect.sync(() => {
          asked.push(argv)
          return over.allow ?? "allow"
        }),
      judge,
    })
    const root: TaskSpec = {
      ...specFor(bot, {
        ...(over.repo === false
          ? {}
          : { repo: { url: "https://github.com/renzer83/shoalwork-sandbox", base: "main" } }),
      }),
      id: newTaskId(),
    }
    const input: VerifyInput = {
      root,
      step: { ...step("a"), checks: checks.map((argv) => ({ argv })) },
      botId: bot.id,
      taskId: newTaskId(),
      base: branch,
      verdict: okVerdict(branch),
    }
    return { verify, input, fake, asked, prepares, branch }
  })

describe("makeStepVerify", () => {
  it.effect("runs each check in the worker's own kept worktree and then releases it", () =>
    Effect.gen(function* () {
      const { verify, input, fake, prepares, branch } = yield* setup([
        ["pnpm", "lint"],
        ["pnpm", "test"],
      ])
      const result = yield* verify(input)
      expect(result.final).toBe("ok")
      expect(result.tests).toBe("pass")
      expect(fake.commands).toEqual([
        ["pnpm", "lint"],
        ["pnpm", "test"],
      ])
      // The kept worktree of the step's branch is continued (reuse), not a fresh checkout.
      expect(prepares).toHaveLength(1)
      expect(prepares[0]?.reuse).toEqual({ path: KEPT.path, branch })
      expect(branch.endsWith(String(prepares[0]?.stepId))).toBe(true)
      expect(fake.released).toEqual([{ keepWorktree: false }])
    }).pipe(Effect.provide(DispatchLayer)),
  )

  it.effect("the worktree stays until the checks finish: it is released only after the last command", () =>
    Effect.gen(function* () {
      const { verify, input, fake } = yield* setup([["pnpm", "test"]], { answer: () => exec(1) })
      yield* verify(input)
      expect(fake.released).toEqual([{ keepWorktree: false }])
      expect(fake.commands).toHaveLength(1)
    }).pipe(Effect.provide(DispatchLayer)),
  )

  it.effect("a worker worktree that is gone sends the step to a person; nothing runs", () =>
    Effect.gen(function* () {
      const { verify, input, fake } = yield* setup([["pnpm", "test"]], { kept: false })
      const result = yield* verify(input)
      expect(result.final).toBe("needs_human")
      expect(result.notes).toEqual(["the worker's worktree is no longer there, so its checks cannot run"])
      expect(fake.commands).toEqual([])
    }).pipe(Effect.provide(DispatchLayer)),
  )

  it.effect("a plan without a repo checks in a fresh context of its own", () =>
    Effect.gen(function* () {
      const { verify, input, prepares } = yield* setup([["pnpm", "test"]], { repo: false })
      expect((yield* verify(input)).final).toBe("ok")
      expect(prepares[0]?.reuse).toBeUndefined()
    }).pipe(Effect.provide(DispatchLayer)),
  )

  it.effect("a command the Policy refuses is never run and goes to a person with the reason", () =>
    Effect.gen(function* () {
      const { verify, input, fake, asked } = yield* setup([["pnpm", "test"]], { allow: "refused" })
      const result = yield* verify(input)
      expect(asked).toEqual([["pnpm", "test"]])
      expect(fake.commands).toEqual([])
      expect(result.final).toBe("needs_human")
      expect(result.notes[0]).toContain("refused by policy")
      expect(fake.released).toEqual([{ keepWorktree: false }])
    }).pipe(Effect.provide(DispatchLayer)),
  )

  it.effect("a failing or timed-out command fails the step, naming the command", () =>
    Effect.gen(function* () {
      const failing = yield* setup([["pnpm", "test"]], { answer: () => exec(1) })
      const failed = yield* failing.verify(failing.input)
      expect(failed.final).toBe("failed")
      expect(failed.notes).toEqual(["the acceptance command `pnpm test` exited with 1"])
      const slow = yield* setup([["pnpm", "test"]], { answer: () => exec(0, true) })
      expect((yield* slow.verify(slow.input)).final).toBe("failed")
    }).pipe(Effect.provide(DispatchLayer)),
  )

  it.effect("a step with no checks gets no worktree", () =>
    Effect.gen(function* () {
      const { verify, input, prepares } = yield* setup([])
      yield* verify(input)
      expect(prepares).toEqual([])
    }).pipe(Effect.provide(DispatchLayer)),
  )

  it.effect("a worktree that cannot be prepared is not the step's fault: needs_human", () =>
    Effect.gen(function* () {
      const { verify, input, fake } = yield* setup([["pnpm", "test"]], { failPrepare: true })
      const result = yield* verify(input)
      expect(result.final).toBe("needs_human")
      expect(result.notes).toEqual(["the verification worktree could not be prepared"])
      expect(fake.commands).toEqual([])
    }).pipe(Effect.provide(DispatchLayer)),
  )
})
