import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import { Beacon, BeaconTest } from "@shoalwork/beacon"
import { BotId, type PolicyDecision, streamIds, type ToolCall } from "@shoalwork/contracts"
import { Effect, Layer, Schema, Stream } from "effect"
import { describe, expect } from "vitest"
import { makePolicyTest, Policy } from "../src/index.js"
import { argvMatch, globMatch, parseArgvPattern, parseToolPattern } from "../src/match.js"
import { parseShell } from "../src/shell.js"

const DEFAULT_YAML = readFileSync(new URL("../../../config/policies/default.yaml", import.meta.url), "utf8")
const BOT = Schema.decodeUnknownSync(BotId)("bot_3f2a9c1e-7b4d-4e8a-9f10-2c6d5e8b7a41")
const OTHER_BOT = Schema.decodeUnknownSync(BotId)("bot_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d")

const bash = (command: string): ToolCall => ({ tool: "Bash", input: { command } })

// Builds the Policy service with Beacon in memory, so tests can read what was recorded.
const policyWith = (
  sources: Record<string, string>,
  policyOf: (id: BotId) => string | undefined = () => "default",
) => makePolicyTest({ sources, policyOf }).pipe(Layer.provideMerge(BeaconTest))

const baseLayer = policyWith({ default: DEFAULT_YAML })

const evaluate = (call: ToolCall) =>
  Effect.gen(function* () {
    const policy = yield* Policy
    return yield* policy.evaluate(BOT, call)
  })

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

// Allow for one exact command. An allow on "git push origin *" is rejected at load (the :main probe deletes).
const DEV_ALLOW_PUSH_MAIN = `rules:\n  - { bot: "*", tool: "Bash(git push origin main)", effect: allow }\n`

describe("policy.denied event", () => {
  it.effect("is recorded on the bot stream for a deny", () =>
    Effect.gen(function* () {
      const policy = yield* Policy
      yield* policy.evaluate(BOT, bash("rm -rf /"))
      const beacon = yield* Beacon
      const events = yield* Stream.runCollect(beacon.readAll(0, ["policy.denied"]))
      expect(events).toHaveLength(1)
      const [event] = events
      expect(event?.streamId).toBe(streamIds.bot(BOT))
      expect(event?.payload).toMatchObject({ botId: BOT, tool: "Bash" })
      const payload = event?.payload as { rule: string } | undefined
      expect(payload?.rule).toContain("deny")
    }).pipe(Effect.provide(baseLayer)),
  )

  it.effect("is not recorded for ask or allow", () =>
    Effect.gen(function* () {
      const policy = yield* Policy
      yield* policy.evaluate(BOT, bash("git push origin main"))
      yield* policy.evaluate(BOT, bash("git status"))
      const beacon = yield* Beacon
      expect(yield* Stream.runCollect(beacon.readAll(0, ["policy.denied"]))).toHaveLength(0)
    }).pipe(Effect.provide(baseLayer)),
  )
})

describe("fail closed", () => {
  it.effect("falls back to the default policy when the bot has no policy name", () =>
    Effect.gen(function* () {
      const decision = yield* evaluate(bash("git status"))
      expect(decision.effect).toBe("allow")
    }).pipe(Effect.provide(policyWith({ default: DEFAULT_YAML }, () => undefined))),
  )

  it.effect("asks when the policy name is unknown", () =>
    Effect.gen(function* () {
      const decision = yield* evaluate(bash("git status"))
      expect(decision.effect).toBe("ask")
    }).pipe(Effect.provide(policyWith({ default: DEFAULT_YAML }, () => "missing"))),
  )

  it.effect("asks when policyOf throws", () =>
    Effect.gen(function* () {
      const decision = yield* evaluate(bash("git status"))
      expect(decision.effect).toBe("ask")
    }).pipe(
      Effect.provide(
        policyWith({ default: DEFAULT_YAML }, () => {
          throw new Error("lookup failed")
        }),
      ),
    ),
  )

  it.effect("asks for a Bash call without a command string", () =>
    Effect.gen(function* () {
      const decision = yield* evaluate({ tool: "Bash", input: { cmd: "git status" } })
      expect(decision.effect).toBe("ask")
    }).pipe(Effect.provide(baseLayer)),
  )
})

describe("reload", () => {
  it.effect("keeps the rules when the sources still compile", () =>
    Effect.gen(function* () {
      const policy = yield* Policy
      yield* policy.reload()
      const decision = yield* evaluate(bash("rm -rf /"))
      expect(decision.effect).toBe("deny")
    }).pipe(Effect.provide(baseLayer)),
  )
})

// Hostile shapes: long words, separators, nested substitution, backticks, an unterminated quote.
const hostileCommands = (size: number): ReadonlyArray<string> => [
  `git status ${"a ".repeat(size / 2)}`,
  ";".repeat(size),
  "$(".repeat(size / 2),
  `echo ${"`".repeat(size)}`,
  `"${"x".repeat(size)}`,
]

describe("hostile input stays fast", () => {
  // Generous on purpose: inputs just under the 16 KB cap take ~15 ms locally; shared CI runners are slower.
  const LIMIT_MS = 500
  const timed = (fn: () => void): number => {
    const start = performance.now()
    fn()
    return performance.now() - start
  }

  it.effect("evaluates commands just under the input cap in well under the limit", () =>
    Effect.gen(function* () {
      const policy = yield* Policy
      for (const command of hostileCommands(15_000)) {
        const start = performance.now()
        const decision = yield* policy.evaluate(BOT, bash(command))
        expect(performance.now() - start).toBeLessThan(LIMIT_MS)
        expect(["allow", "ask", "deny"]).toContain(decision.effect)
      }
    }).pipe(Effect.provide(baseLayer)),
  )

  it.effect("matches a resource against a pattern full of wildcards", () =>
    Effect.gen(function* () {
      const policy = yield* Policy
      const elapsed = yield* Effect.sync(() =>
        timed(() => globMatch("*a*a*a*a*a*a*a*a*b", "a".repeat(200_000), true)),
      )
      expect(elapsed).toBeLessThan(LIMIT_MS)
      const resource = "a".repeat(15_000)
      const decision = yield* policy.evaluate(BOT, { tool: "Read", input: {}, resource })
      expect(decision.effect).toBe("allow")
    }).pipe(
      Effect.provide(
        policyWith(
          {
            default: DEFAULT_YAML,
            dev: `rules:\n  - { bot: "*", tool: "Read(*a*a*a*a*b)", effect: deny }\n`,
          },
          () => "dev",
        ),
      ),
    ),
  )
})

describe("input size cap", () => {
  // Measured before any lexing: a 200 KB input must come back in well under 50 ms.
  const ASK_LIMIT_MS = 50

  it.effect("asks at once for 200 KB commands without parsing them", () =>
    Effect.gen(function* () {
      const policy = yield* Policy
      for (const command of hostileCommands(200_000)) {
        const start = performance.now()
        const decision = yield* policy.evaluate(BOT, bash(command))
        expect(performance.now() - start).toBeLessThan(ASK_LIMIT_MS)
        expect(decision).toEqual({ effect: "ask", risk: "irreversible" })
      }
    }).pipe(Effect.provide(baseLayer)),
  )

  it.effect("asks at once for an oversized resource or path field", () =>
    Effect.gen(function* () {
      const policy = yield* Policy
      const big = "a".repeat(200_000)
      const readPath = yield* policy.evaluate(BOT, { tool: "Read", input: { file_path: big } })
      const editPath = yield* policy.evaluate(BOT, { tool: "Edit", input: { file_path: `src/${big}.ts` } })
      const resource = yield* policy.evaluate(BOT, { tool: "Read", input: {}, resource: big })
      expect(readPath).toEqual({ effect: "ask", risk: "irreversible" })
      expect(editPath).toEqual({ effect: "ask", risk: "irreversible" })
      expect(resource).toEqual({ effect: "ask", risk: "irreversible" })
    }).pipe(Effect.provide(baseLayer)),
  )

  it.effect("keeps deny for inputs that fit under the cap", () =>
    Effect.gen(function* () {
      const policy = yield* Policy
      const small = yield* policy.evaluate(BOT, { tool: "Read", input: { file_path: "config/.secret" } })
      const large = yield* policy.evaluate(BOT, {
        tool: "Read",
        input: { file_path: `${"a/".repeat(10_000)}.secret` },
      })
      expect(small.effect).toBe("deny")
      expect(large).toEqual({ effect: "ask", risk: "irreversible" })
    }).pipe(
      Effect.provide(
        policyWith(
          {
            default: DEFAULT_YAML,
            dev: `rules:\n  - { bot: "*", tool: "Read(**/*.secret)", effect: deny }\n`,
          },
          () => "dev",
        ),
      ),
    ),
  )

  it.effect("uses the cap given to the layer", () =>
    Effect.gen(function* () {
      const policy = yield* Policy
      const plain = yield* policy.evaluate(BOT, bash("git status"))
      const padded = yield* policy.evaluate(BOT, bash(`git status ${" ".repeat(200)}`))
      expect(plain.effect).toBe("allow")
      expect(padded).toEqual({ effect: "ask", risk: "irreversible" })
    }).pipe(
      Effect.provide(
        makePolicyTest({
          sources: { default: DEFAULT_YAML },
          policyOf: () => "default",
          maxInputBytes: 100,
        }).pipe(Layer.provideMerge(BeaconTest)),
      ),
    ),
  )
})

describe("shell lexer", () => {
  it("reads one simple command", () => {
    const parsed = parseShell("git status")
    expect(parsed.compound).toBe(false)
    expect(parsed.segments).toEqual([{ argv: ["git", "status"], opaque: false }])
  })

  it("splits on ; && || | and newlines", () => {
    for (const command of [
      "git status; rm x",
      "git status && rm x",
      "git status || rm x",
      "git status | rm x",
      "git status\nrm x",
    ]) {
      const parsed = parseShell(command)
      expect(parsed.compound).toBe(true)
      expect(parsed.segments.map((s) => s.argv[0])).toEqual(expect.arrayContaining(["git", "rm"]))
    }
  })

  it("removes quotes so a quoted flag is a plain word", () => {
    expect(parseShell('git push "--force" origin').segments[0]?.argv).toEqual([
      "git",
      "push",
      "--force",
      "origin",
    ])
    expect(parseShell("git push '--force'").segments[0]?.argv).toEqual(["git", "push", "--force"])
  })

  it("keeps separators inside quotes as text", () => {
    const parsed = parseShell('git commit -m "feat; x"')
    expect(parsed.compound).toBe(false)
    expect(parsed.segments[0]?.argv).toEqual(["git", "commit", "-m", "feat; x"])
  })

  it("marks unquoted expansions, globs, env prefixes and unterminated quotes", () => {
    expect(parseShell("echo $HOME").compound).toBe(true)
    expect(parseShell("git status *").compound).toBe(true)
    expect(parseShell("FOO=1 git status").compound).toBe(true)
    expect(parseShell('git log "abc').unterminated).toBe(true)
    expect(parseShell("git status\\").compound).toBe(true)
  })

  it("treats command substitution as compound and exposes the inner command", () => {
    const parsed = parseShell("echo $(rm -rf /)")
    expect(parsed.compound).toBe(true)
    expect(parsed.segments.some((s) => s.argv[0] === "rm")).toBe(true)
  })

  it("exposes a command hidden in double quotes via command substitution", () => {
    const parsed = parseShell('echo "$(rm -rf /)"')
    expect(parsed.compound).toBe(true)
    expect(parsed.segments.some((s) => s.argv[0] === "rm")).toBe(true)
  })
})

describe("glob and argv matching", () => {
  it("matches word globs and crosses slashes in word mode", () => {
    expect(globMatch("a*", "a/b", false)).toBe(true)
    expect(globMatch("a?c", "abc", false)).toBe(true)
    expect(globMatch("--force*", "--force-with-lease", false)).toBe(true)
  })

  it("keeps * and ? inside one path segment and lets ** cross them", () => {
    expect(globMatch("src/*.ts", "src/a/b.ts", true)).toBe(false)
    expect(globMatch("src/**/*.ts", "src/a/b.ts", true)).toBe(true)
    expect(globMatch("**/.env*", ".env", true)).toBe(true)
    expect(globMatch("**/.env*", "apps/web/.env.local", true)).toBe(true)
    expect(globMatch("*.ts", "a/b.ts", true)).toBe(false)
    expect(globMatch("a?c", "a/c", true)).toBe(false)
  })

  it("matches argv word by word, with * for zero or more words", () => {
    expect(argvMatch(["git", "push", "*"], ["git", "push"])).toBe(true)
    expect(argvMatch(["git", "push", "*"], ["git", "push", "--force", "origin"])).toBe(true)
    expect(argvMatch(["git", "push", "*", "--force*", "*"], ["git", "push", "--force"])).toBe(true)
    expect(argvMatch(["git", "push", "*"], ["git", "status"])).toBe(false)
    expect(argvMatch(["rm", "*r*", "/"], ["rm", "-rf", "/"])).toBe(true)
    expect(argvMatch(["git", "push"], ["git", "pushx"])).toBe(false)
  })

  it("parses tool patterns and rejects malformed ones", () => {
    expect(parseToolPattern("Bash(git push *)")).toEqual({ name: "Bash", spec: "git push *" })
    expect(parseToolPattern("Read")).toEqual({ name: "Read", spec: undefined })
    expect(parseToolPattern("mcp__*")).toEqual({ name: "mcp__*", spec: undefined })
    expect(parseToolPattern("Bash(git")).toBeUndefined()
    expect(parseToolPattern("Bash()")).toBeUndefined()
    expect(parseToolPattern("mcp__*(x)")).toBeUndefined()
    expect(parseToolPattern("")).toBeUndefined()
  })

  it("refuses shell syntax in Bash patterns", () => {
    expect(parseArgvPattern("git push *")).toEqual(["git", "push", "*"])
    expect(parseArgvPattern("git push; rm -rf *")).toBeUndefined()
    expect(parseArgvPattern("git $(rm)")).toBeUndefined()
    expect(parseArgvPattern("   ")).toBeUndefined()
  })
})
