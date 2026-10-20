import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import { Beacon, BeaconTest } from "@shoalwork/beacon"
import { BotId, type ToolCall } from "@shoalwork/contracts"
import { Effect, Layer, Schema, Stream } from "effect"
import { describe, expect, it as plain } from "vitest"
import { makePolicyTest, Policy, redactResource } from "../src/index.js"
import { compilePolicies } from "../src/loader.js"
import { globMatch } from "../src/match.js"

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

describe("default policy: writes, reads and searches on sensitive paths", () => {
  const deny: ReadonlyArray<ToolCall> = [
    { tool: "Write", input: { file_path: ".git/hooks/pre-commit" } },
    { tool: "Edit", input: { file_path: "/Users/x/repo/.git/config" } },
    { tool: "MultiEdit", input: { file_path: ".env.local" } },
    { tool: "NotebookEdit", input: { notebook_path: ".git/x.ipynb" } },
    { tool: "Write", input: { file_path: "config/policies/dev.yaml" } },
    { tool: "Edit", input: { file_path: "/etc/hosts" } },
    { tool: "Write", input: { file_path: "/usr/local/x" } },
    { tool: "Write", input: { file_path: "~/notes.txt" } },
    { tool: "Write", input: { file_path: ".ENV" } },
    { tool: "Grep", input: { pattern: "x", path: ".env" } },
    { tool: "Grep", input: { pattern: ".env" } },
    { tool: "Glob", input: { pattern: "**/.env*" } },
    { tool: "Read", input: { file_path: "/Users/x/.ssh/id_ed25519" } },
    { tool: "Read", input: { file_path: ".aws/credentials" } },
    { tool: "Read", input: { file_path: "certs/server.pem" } },
    { tool: "Read", input: { file_path: "keys/id_rsa.bak" } },
    { tool: "Read", input: { file_path: ".ENV" } },
  ]
  deny.forEach((call, i) => {
    it.effect(`denies ${call.tool} #${i}`, () =>
      effectOf(call).pipe(Effect.map((effect) => expect(effect).toBe("deny"))),
    )
  })

  const ask: ReadonlyArray<ToolCall> = [
    { tool: "Write", input: { file_path: "bots/tech.yaml" } },
    { tool: "Edit", input: { file_path: "apps/x/bots/a.yaml" } },
    { tool: "Write", input: { file_path: ".github/workflows/ci.yml" } },
  ]
  ask.forEach((call, i) => {
    it.effect(`asks for ${call.tool} #${i}`, () =>
      effectOf(call).pipe(Effect.map((effect) => expect(effect).toBe("ask"))),
    )
  })

  const allow: ReadonlyArray<ToolCall> = [
    { tool: "Write", input: { file_path: "packages/policy/src/x.ts" } },
    { tool: "Read", input: { file_path: "src/index.ts" } },
    { tool: "Read", input: { file_path: "config/policies/default.yaml" } },
    { tool: "Grep", input: { pattern: "foo", path: "src" } },
  ]
  allow.forEach((call, i) => {
    it.effect(`allows ${call.tool} #${i}`, () =>
      effectOf(call).pipe(Effect.map((effect) => expect(effect).toBe("allow"))),
    )
  })

  it.effect("a bot without a policy name uses the default policy", () =>
    Effect.gen(function* () {
      const policy = yield* Policy
      const safe = yield* policy.evaluate(BOT, bash("git status"))
      const dangerous = yield* policy.evaluate(BOT, bash("rm -rf /"))
      expect(safe.effect).toBe("allow")
      expect(dangerous.effect).toBe("deny")
    }).pipe(Effect.provide(withChild(undefined, () => undefined))),
  )

  it.effect("an unknown policy name still asks", () =>
    effectOf(bash("git status"))
      .pipe(Effect.map((effect) => expect(effect).toBe("allow")))
      .pipe(Effect.provide(withChild(undefined, () => "missing"))),
  )
})

describe("path rules", () => {
  it.effect("compare paths case-insensitively", () =>
    effectOf({ tool: "Write", input: { file_path: "Config/Policies/x.yaml" } }).pipe(
      Effect.map((effect) => expect(effect).toBe("deny")),
    ),
  )

  it.effect("deny applies when any candidate field matches", () =>
    effectOf({ tool: "Grep", input: { path: "src", pattern: ".env" } }).pipe(
      Effect.map((effect) => expect(effect).toBe("deny")),
    ),
  )

  it.effect("allow needs every candidate to match", () =>
    Effect.gen(function* () {
      const mixed = yield* effectOf(
        { tool: "mcp__x", input: { file_path: "src/a.ts", path: "/etc/x" } },
        allowRule("mcp__x(src/**)"),
      )
      const single = yield* effectOf(
        { tool: "mcp__x", input: { file_path: "src/a.ts" } },
        allowRule("mcp__x(src/**)"),
      )
      expect(mixed).toBe("ask")
      expect(single).toBe("allow")
    }),
  )

  plain("a globstar followed by a literal needs a segment start", () => {
    expect(globMatch("**/foo", "foo", true)).toBe(true)
    expect(globMatch("**/foo", "a/foo", true)).toBe(true)
    expect(globMatch("**/foo", "barfoo", true)).toBe(false)
    expect(globMatch("**/foo", "a/barfoo", true)).toBe(false)
    expect(globMatch("src/**", "src/a/b", true)).toBe(true)
    expect(globMatch("*.ts", "a/b.ts", true)).toBe(false)
  })

  plain("the deny floor: a child cannot weaken an inherited deny", () => {
    expect(loadFails(allowRule("Read(.env*)"))).toContain("cannot weaken")
    expect(loadFails(`rules:\n  - { bot: "*", tool: "Read(.env*)", effect: ask }\n`)).toContain(
      "cannot weaken",
    )
    expect(
      Effect.runSync(Effect.result(compilePolicies({ default: DEFAULT_YAML, dev: denyRule("Read(.env*)") })))
        ._tag,
    ).toBe("Success")
  })
})

describe("MCP tools", () => {
  it.effect("asks for a payment or delete tool", () =>
    effectOf({ tool: "mcp__stripe__charge", input: {} }).pipe(
      Effect.map((effect) => expect(effect).toBe("ask")),
    ),
  )
  it.effect("asks for an irreversible MCP tool even when a child allows the server", () =>
    effectOf({ tool: "mcp__github__delete_repo", input: {} }, allowRule("mcp__github__*")).pipe(
      Effect.map((effect) => expect(effect).toBe("ask")),
    ),
  )
  it.effect("allows a narrow MCP allow", () =>
    effectOf({ tool: "mcp__github__create_issue", input: { title: "x" } }, allowRule("mcp__github__*")).pipe(
      Effect.map((effect) => expect(effect).toBe("allow")),
    ),
  )
  plain("a child allow on every MCP tool is rejected", () => {
    expect(loadFails(allowRule("mcp__*"))).toContain("irreversible")
  })
})

describe("policy.denied resource is redacted and capped", () => {
  plain("drops the query string and masks secret-looking values", () => {
    expect(redactResource("https://api.x.io/v1?token=abc123&x=1")).toBe("https://api.x.io/v1?[redacted]")
    expect(redactResource("config password=hunter2 done")).not.toContain("hunter2")
    expect(redactResource("config password=hunter2 done")).toContain("password=[redacted]")
    expect(redactResource("sk-abcdefghijklmnop")).toBe("[redacted]")
    expect(redactResource("a".repeat(500)).length).toBe(201)
  })

  it.effect("records the redacted resource", () =>
    Effect.gen(function* () {
      const policy = yield* Policy
      yield* policy.evaluate(BOT, { tool: "Read", input: {}, resource: ".env?token=abc" })
      const beacon = yield* Beacon
      const [event] = yield* Stream.runCollect(beacon.readAll(0, ["policy.denied"]))
      expect((event?.payload as { resource?: string } | undefined)?.resource).toBe(".env?[redacted]")
    }).pipe(Effect.provide(withChild())),
  )
})
