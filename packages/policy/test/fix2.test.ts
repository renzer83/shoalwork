import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import { BeaconTest } from "@shoalwork/beacon"
import { BotId, type ToolCall } from "@shoalwork/contracts"
import { Effect, Layer, Schema } from "effect"
import { describe, expect, it as plain } from "vitest"
import { type EvaluationContext, makePolicyTest, Policy } from "../src/index.js"
import { compilePolicies } from "../src/loader.js"
import { REMOTE_EXEC_PROBES } from "../src/risk.js"

// Fix round 2: package-manager exec, workspace roots, wrapper heads, shell options and keywords, git value options,
// credential and agent-config paths.
const DEFAULT_YAML = readFileSync(new URL("../../../config/policies/default.yaml", import.meta.url), "utf8")
const BOT = Schema.decodeUnknownSync(BotId)("bot_3f2a9c1e-7b4d-4e8a-9f10-2c6d5e8b7a41")
const bash = (command: string): ToolCall => ({ tool: "Bash", input: { command } })
const allowRule = (tool: string): string => `rules:\n  - { bot: "*", tool: "${tool}", effect: allow }\n`
const denyRule = (tool: string): string => `rules:\n  - { bot: "*", tool: "${tool}", effect: deny }\n`

interface RunOptions {
  readonly child?: string
  readonly roots?: ReadonlyArray<string>
  readonly context?: EvaluationContext
}

const run = (call: ToolCall, options: RunOptions = {}) =>
  Effect.gen(function* () {
    const policy = yield* Policy
    return (yield* policy.evaluate(BOT, call, options.context)).effect
  }).pipe(
    Effect.provide(
      makePolicyTest({
        sources:
          options.child === undefined
            ? { default: DEFAULT_YAML }
            : { default: DEFAULT_YAML, dev: options.child },
        policyOf: () => (options.child === undefined ? "default" : "dev"),
        workspaceRoots: options.roots ?? [],
      }).pipe(Layer.provideMerge(BeaconTest)),
    ),
  )

const expectOne = (
  name: string,
  call: ToolCall,
  expected: string | ReadonlyArray<string>,
  options?: RunOptions,
) =>
  it.effect(name, () =>
    Effect.gen(function* () {
      const effect = yield* run(call, options)
      if (typeof expected === "string") {
        expect(effect).toBe(expected)
      } else {
        expect(expected).toContain(effect)
      }
    }),
  )

const loads = (child: string): boolean =>
  Effect.runSync(Effect.result(compilePolicies({ default: DEFAULT_YAML, dev: child })))._tag === "Success"

const loadMessage = (child: string): string => {
  const result = Effect.runSync(Effect.result(compilePolicies({ default: DEFAULT_YAML, dev: child })))
  if (result._tag === "Success") {
    throw new Error("expected rejection")
  }
  return result.failure.message
}

describe("package manager exec: unwrapped, remote runners never allowed", () => {
  const pnpmAllow = allowRule("Bash(pnpm *)")
  plain("an allow on pnpm loads, because the exec probes are judged by their inner command", () => {
    expect(loads(pnpmAllow)).toBe(true)
  })
  for (const command of [
    "pnpm exec rm -rf /",
    "npm exec -- rm -rf /",
    "pnpm exec bash -c 'rm -rf /'",
    "npm x rm -rf /",
    "pnpm dlx x",
  ]) {
    expectOne(`with an allow on pnpm, asks or denies: ${command}`, bash(command), ["ask", "deny"], {
      child: pnpmAllow,
    })
  }
  expectOne(
    "with an allow on pnpm, asks for an irreversible inner command",
    bash("pnpm exec rm -rf ./x"),
    "ask",
    {
      child: pnpmAllow,
    },
  )
  expectOne("with an allow on pnpm, still allows a plain script", bash("pnpm run build"), "allow", {
    child: pnpmAllow,
  })
  plain("every remote runner probe is compound (never allowed)", () => {
    expect(REMOTE_EXEC_PROBES.length).toBeGreaterThan(0)
  })
  for (const probe of REMOTE_EXEC_PROBES) {
    expectOne(
      `with an allow on pnpm, remote runner asks: ${String((probe.input as { command?: string }).command)}`,
      probe,
      "ask",
      {
        child: pnpmAllow,
      },
    )
  }
  for (const command of ["npm x rm -rf /"]) {
    expectOne(`with an allow on npm, remote runner asks: ${command}`, bash(command), "ask", {
      child: allowRule("Bash(npm *)"),
    })
  }
})

describe("wrapper heads named in an allow are rejected at load", () => {
  for (const head of [
    "busybox",
    "chroot",
    "flock",
    "ionice",
    "su",
    "ssh",
    "script",
    "watch",
    "parallel",
    "caffeinate",
    "arch",
    "pkexec",
    "doas",
    "time",
    "nice",
    "exec",
    "sudo",
  ]) {
    plain(`rejects allow on ${head}`, () => {
      expect(loadMessage(allowRule(`Bash(${head} *)`))).toContain("wrapper head")
    })
  }
  plain("rejects a glob head that reaches a wrapper", () => {
    expect(loadMessage(allowRule("Bash(en* *)"))).toContain("wrapper head")
  })
})

describe("shell options and keywords", () => {
  expectOne("asks for -o before -c", bash("bash -o pipefail -c 'rm -rf ./x'"), "ask")
  expectOne("asks for -O before -c", bash("bash -O extglob -c 'git push --force origin main'"), "ask")
  expectOne("asks for --rcfile before -c", bash("bash --rcfile x -c 'rm -rf ./x'"), "ask")
  expectOne("denies a push behind -o before -c", bash("bash -o pipefail -c 'git push origin main'"), "deny", {
    child: denyRule("Bash(git push *)"),
  })
  expectOne("asks for an irreversible command after if", bash("if rm -rf ./x; then echo done; fi"), "ask")
  expectOne("denies a push after while/do", bash("while true; do git push origin main; done"), "deny", {
    child: denyRule("Bash(git push *)"),
  })
  expectOne("asks for a push after !", bash("! git push --force origin main"), "ask")
  expectOne("asks for a compound with a keyword", bash("if git status; then git status; fi"), "ask")
})

describe("git global value options are skipped", () => {
  expectOne(
    "asks for a force push after --git-dir with a value",
    bash("git --git-dir x push --force origin main"),
    "ask",
  )
  expectOne(
    "denies a push after --namespace with a value",
    bash("git --namespace foo push origin main"),
    "deny",
    {
      child: denyRule("Bash(git push *)"),
    },
  )
  expectOne(
    "denies a push after --work-tree with a value",
    bash("git --work-tree . push origin main"),
    "deny",
    {
      child: denyRule("Bash(git push *)"),
    },
  )
})
