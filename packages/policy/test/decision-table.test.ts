import { it } from "@effect/vitest"
import type { PolicyDecision, ToolCall } from "@shoalwork/contracts"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { Policy } from "../src/index.js"
import {
  BOT,
  baseLayer,
  bash,
  DEFAULT_YAML,
  DEV_ALLOW_PUSH_MAIN,
  evaluate,
  OTHER_BOT,
  policyWith,
} from "./support.js"

describe("base policy decision table", () => {
  const cases: ReadonlyArray<readonly [string, ToolCall, PolicyDecision["effect"]]> = [
    ["reads a file without asking", { tool: "Read", input: { file_path: "src/a.ts" } }, "allow"],
    ["searches the repo without asking", { tool: "Grep", input: { pattern: "x" } }, "allow"],
    ["edits a source file locally", { tool: "Edit", input: { file_path: "src/a.ts" } }, "allow"],
    ["runs git status", bash("git status"), "allow"],
    ["runs git log with flags", bash("git log --oneline -5"), "allow"],
    ["runs a package manager script", bash("pnpm --filter @shoalwork/policy test"), "allow"],
    ["commits locally", bash('git commit -m "feat: policy"'), "allow"],
    ["asks before pushing", bash("git push origin main"), "ask"],
    ["asks before a force push", bash("git push --force origin main"), "ask"],
    ["asks before a recursive delete below the repo", bash("rm -rf ./build"), "ask"],
    ["denies a recursive delete of the root", bash("rm -rf /"), "deny"],
    ["asks before a docker prune", bash("docker system prune -a"), "ask"],
    ["denies a destructive command after &&", bash("git status && rm -rf /"), "deny"],
    ["denies a destructive command inside $(...)", bash("echo $(rm -rf /)"), "deny"],
    [
      "asks when a compound command has an irreversible part",
      bash("git status; git push --force origin main"),
      "ask",
    ],
    ["a quoted --force is still irreversible", bash('git push "--force" origin main'), "ask"],
    ["denies reading a local env file", { tool: "Read", input: { file_path: ".env.local" } }, "deny"],
    [
      "denies reading an env file in a subdirectory",
      { tool: "Read", input: { file_path: "apps/web/.env" } },
      "deny",
    ],
    ["denies a destructive command on a second line", bash("git status\nrm -rf /"), "deny"],
    ["asks for an unknown tool", { tool: "Foo", input: {} }, "ask"],
    ["asks for a payment tool", { tool: "stripe.charge", input: {} }, "ask"],
    ["asks when an env prefix hides the command", bash("GIT_SSH_COMMAND=x git push origin main"), "ask"],
    ["asks for a local binary named git", bash("./git status"), "ask"],
    ["asks for an unterminated quote", bash('git log --grep="abc'), "ask"],
    ["asks when an unquoted glob could expand to a flag", bash("git push origin *"), "ask"],
  ]

  for (const [name, call, expected] of cases) {
    it.effect(name, () =>
      Effect.gen(function* () {
        const decision = yield* evaluate(call)
        expect(decision.effect).toBe(expected)
      }).pipe(Effect.provide(baseLayer)),
    )
  }

  it.effect("reports the risk level next to the effect", () =>
    Effect.gen(function* () {
      const decision = yield* evaluate(bash("git push origin main"))
      expect(decision).toEqual({ effect: "ask", risk: "external" })
    }).pipe(Effect.provide(baseLayer)),
  )
})

describe("precedence deny -> ask -> allow", () => {
  it.effect("an allow rule lets a simple external command through", () =>
    Effect.gen(function* () {
      const decision = yield* evaluate(bash("git push origin main"))
      expect(decision.effect).toBe("allow")
      expect(decision.rule?.effect).toBe("allow")
    }).pipe(Effect.provide(policyWith({ default: DEFAULT_YAML, dev: DEV_ALLOW_PUSH_MAIN }, () => "dev"))),
  )

  it.effect("a deny from the base beats an allow in the child", () =>
    Effect.gen(function* () {
      const decision = yield* evaluate(bash("rm -rf /tmp/x"))
      expect(decision.effect).toBe("deny")
      expect(decision.rule?.effect).toBe("deny")
    }).pipe(
      Effect.provide(
        policyWith(
          {
            default: DEFAULT_YAML,
            dev: `rules:\n  - { bot: "*", tool: "Bash(rm -rf /tmp/*)", effect: allow }\n`,
          },
          () => "dev",
        ),
      ),
    ),
  )

  it.effect("an ask beats an allow at the same time", () =>
    Effect.gen(function* () {
      const decision = yield* evaluate(bash("git push origin main"))
      expect(decision.effect).toBe("ask")
    }).pipe(
      Effect.provide(
        policyWith(
          {
            default: DEFAULT_YAML,
            dev: `rules:
  - { bot: "*", tool: "Bash(git push origin *)", effect: ask }
  - { bot: "*", tool: "Bash(git push origin main)", effect: allow }
`,
          },
          () => "dev",
        ),
      ),
    ),
  )

  it.effect("the most specific deny wins inside the same level", () =>
    Effect.gen(function* () {
      const decision = yield* evaluate(bash("rm -rf /"))
      expect(decision.effect).toBe("deny")
      expect(decision.rule?.tool).toBe("Bash(rm -rf /)")
    }).pipe(
      Effect.provide(
        policyWith(
          {
            default: DEFAULT_YAML,
            dev: `rules:\n  - { bot: "*", tool: "Bash(rm -rf /)", effect: deny }\n`,
          },
          () => "dev",
        ),
      ),
    ),
  )

  it.effect("a compound command is never allowed by an allow rule", () =>
    Effect.gen(function* () {
      const decision = yield* evaluate(bash("git push origin main && git push origin main"))
      expect(decision.effect).toBe("ask")
    }).pipe(Effect.provide(policyWith({ default: DEFAULT_YAML, dev: DEV_ALLOW_PUSH_MAIN }, () => "dev"))),
  )

  it.effect("an opaque command is never allowed by an allow rule", () =>
    Effect.gen(function* () {
      const decision = yield* evaluate(bash("git push origin $BRANCH"))
      expect(decision.effect).toBe("ask")
    }).pipe(Effect.provide(policyWith({ default: DEFAULT_YAML, dev: DEV_ALLOW_PUSH_MAIN }, () => "dev"))),
  )

  it.effect("a bot-specific allow applies only to that bot", () =>
    Effect.gen(function* () {
      const policy = yield* Policy
      const mine = yield* policy.evaluate(BOT, bash("git push origin main"))
      const other = yield* policy.evaluate(OTHER_BOT, bash("git push origin main"))
      expect(mine.effect).toBe("allow")
      expect(other.effect).toBe("ask")
    }).pipe(
      Effect.provide(
        policyWith(
          {
            default: DEFAULT_YAML,
            dev: `rules:\n  - { bot: "${BOT}", tool: "Bash(git push origin main)", effect: allow }\n`,
          },
          () => "dev",
        ),
      ),
    ),
  )
})
