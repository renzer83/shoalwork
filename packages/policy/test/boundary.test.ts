import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import { BeaconTest } from "@shoalwork/beacon"
import { BotId, type ToolCall } from "@shoalwork/contracts"
import { Effect, Layer, Schema } from "effect"
import { describe, expect, it as plain } from "vitest"
import { makePolicyTest, Policy } from "../src/index.js"
import { compilePolicies } from "../src/loader.js"

// Boundary cases for the wrapper, shell, package-manager, git, rm, default-policy and MCP rules.
const DEFAULT_YAML = readFileSync(new URL("../../../config/policies/default.yaml", import.meta.url), "utf8")
const BOT = Schema.decodeUnknownSync(BotId)("bot_3f2a9c1e-7b4d-4e8a-9f10-2c6d5e8b7a41")
const bash = (command: string): ToolCall => ({ tool: "Bash", input: { command } })
const allowRule = (tool: string): string => `rules:\n  - { bot: "*", tool: "${tool}", effect: allow }\n`
const denyRule = (tool: string): string => `rules:\n  - { bot: "*", tool: "${tool}", effect: deny }\n`

const withChild = (child?: string, policyOf: () => string | undefined = () => (child ? "dev" : "default")) =>
  makePolicyTest({
    sources: child === undefined ? { default: DEFAULT_YAML } : { default: DEFAULT_YAML, dev: child },
    policyOf,
  }).pipe(Layer.provideMerge(BeaconTest))

const effectOf = (call: ToolCall, child?: string) =>
  Effect.gen(function* () {
    const policy = yield* Policy
    return (yield* policy.evaluate(BOT, call)).effect
  }).pipe(Effect.provide(withChild(child)))

const loadFails = (child: string): string => {
  const result = Effect.runSync(Effect.result(compilePolicies({ default: DEFAULT_YAML, dev: child })))
  if (result._tag === "Success") {
    throw new Error("expected the child policy to be rejected")
  }
  return result.failure.message
}

describe("wrappers and shells: irreversible inner command asks, and the wrapper cannot be allowed", () => {
  const irreversible = [
    "env rm -rf ./x",
    "env FOO=1 env BAR=2 rm -rf ./x",
    "command rm -rf ./x",
    "exec rm -rf ./x",
    "sudo rm -rf ./x",
    "sudo -u root rm -rf ./x",
    "doas rm -rf ./x",
    "nohup rm -rf ./x",
    "timeout 5 rm -rf ./x",
    "nice -n 5 rm -rf ./x",
    "stdbuf -oL rm -rf ./x",
    "time rm -rf ./x",
    "xargs rm -rf",
    "/bin/rm -rf ./x",
    "bash -c 'rm -rf ./x'",
    'sh -c "git push --force origin main"',
    "eval 'git push --force origin main'",
    "python3 -c 'import os'",
    "node -e 'process.exit(0)'",
    "find . -delete",
    "git clean -fd",
    "git reset --hard",
    "git checkout -- .",
    "git restore .",
    "git branch -D feature",
    "git stash clear",
    "git filter-branch --all",
  ]
  for (const command of irreversible) {
    it.effect(`asks: ${command}`, () =>
      effectOf(bash(command)).pipe(Effect.map((effect) => expect(effect).toBe("ask"))),
    )
  }

  it.effect("asks past the unwrap depth limit", () =>
    effectOf(bash("env env env env env git status")).pipe(Effect.map((effect) => expect(effect).toBe("ask"))),
  )

  plain("rejects an allow on a wrapper head at load, even when the exact wrapped command is named", () => {
    expect(loadFails(allowRule("Bash(env git status)"))).toContain("wrapper head")
  })

  it.effect("asks for a wrapper with an untrusted path head", () =>
    effectOf(bash("/usr/bin/env git status")).pipe(Effect.map((effect) => expect(effect).toBe("ask"))),
  )

  it.effect("asks for a local binary named like a wrapper", () =>
    effectOf(bash("./env git status")).pipe(Effect.map((effect) => expect(effect).toBe("ask"))),
  )

  for (const tool of [
    "env *",
    "command *",
    "sudo *",
    "timeout *",
    "nice *",
    "xargs *",
    "bash *",
    "sh *",
    "eval *",
    "find *",
    "python3 *",
    "node *",
    "git *",
    "rm *",
    "exec *",
    "time *",
    "nohup *",
    "stdbuf *",
    "doas *",
  ]) {
    plain(`a child allow on "Bash(${tool})" is rejected at load`, () => {
      expect(loadFails(allowRule(`Bash(${tool})`))).toContain("irreversible")
    })
  }
})

describe("deny and ask see through wrappers, shells and git global options", () => {
  const child = denyRule("Bash(git push *)")
  for (const command of [
    "git -C . push origin main",
    "env git push origin main",
    "bash -c 'git push origin main'",
    "timeout 5 git push origin main",
    "nice -n 5 git push origin main",
    "/usr/bin/env git push origin main",
  ]) {
    it.effect(`denies: ${command}`, () =>
      effectOf(bash(command), child).pipe(Effect.map((effect) => expect(effect).toBe("deny"))),
    )
  }

  it.effect("does not deny an unrelated git command", () =>
    effectOf(bash("git status"), child).pipe(Effect.map((effect) => expect(effect).toBe("allow"))),
  )
})

describe("package managers: whitelist of verbs, global installs asked", () => {
  const allowed = [
    "pnpm run build",
    "pnpm -r test",
    "pnpm --filter @shoalwork/policy test",
    "yarn test",
    "bun build",
    "cargo test -p policy",
  ]
  for (const command of allowed) {
    it.effect(`allows: ${command}`, () =>
      effectOf(bash(command)).pipe(Effect.map((effect) => expect(effect).toBe("allow"))),
    )
  }
  const external = [
    "npm publish",
    "npm i -g typescript",
    "pnpm add -g x",
    "pnpm dlx x",
    "pnpm exec x",
    "cargo install x",
    "cargo publish",
    "npx x",
  ]
  for (const command of external) {
    it.effect(`asks: ${command}`, () =>
      effectOf(bash(command)).pipe(Effect.map((effect) => expect(effect).toBe("ask"))),
    )
  }
})

describe("git read commands with output or external-program flags are not read", () => {
  for (const command of [
    "git diff --output=/tmp/x",
    "git log --ext-diff",
    "git show --textconv HEAD",
    "git diff --no-index a b",
    "git blame -o x",
    "git log --oneline -5",
    "git show HEAD:src/a.ts",
  ]) {
    it.effect(`asks: ${command}`, () =>
      effectOf(bash(command)).pipe(Effect.map((effect) => expect(effect).toBe("ask"))),
    )
  }
  for (const command of ["git status", "git diff --stat"]) {
    it.effect(`allows: ${command}`, () =>
      effectOf(bash(command)).pipe(Effect.map((effect) => expect(effect).toBe("allow"))),
    )
  }
})

describe("rm variants", () => {
  for (const command of ["rm -r -f /", "rm --no-preserve-root -rf /", "rm -fr /tmp/x", "rm -rf ~/x"]) {
    it.effect(`denies: ${command}`, () =>
      effectOf(bash(command)).pipe(Effect.map((effect) => expect(effect).toBe("deny"))),
    )
  }
  it.effect("asks for a recursive delete below the repo", () =>
    effectOf(bash("rm -rf ./build")).pipe(Effect.map((effect) => expect(effect).toBe("ask"))),
  )
})
