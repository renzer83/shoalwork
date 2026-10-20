import { fileURLToPath } from "node:url"
import { ConfigError } from "@shoalwork/contracts"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { compilePolicies, loadPolicySet } from "../src/loader.js"

const POLICY_DIR = fileURLToPath(new URL("../../../config/policies", import.meta.url))
const DEFAULT = `rules:
  - { bot: "*", tool: "Read(.env*)", effect: deny }
  - { bot: "*", tool: "Bash(git status)", effect: allow }
`

const load = (sources: Record<string, string>) => Effect.runSync(Effect.result(compilePolicies(sources)))

const failure = (sources: Record<string, string>): ConfigError => {
  const result = load(sources)
  if (result._tag === "Success") {
    throw new Error("expected a ConfigError, got a policy set")
  }
  return result.failure
}

describe("shipped policies", () => {
  it("loads config/policies with the base policy", () => {
    const set = Effect.runSync(loadPolicySet(POLICY_DIR))
    const rules = set.rulesOf("default") ?? []
    expect(rules.some((r) => r.rule.effect === "deny")).toBe(true)
    expect(rules.some((r) => r.rule.effect === "ask")).toBe(true)
    expect(rules.some((r) => r.rule.effect === "allow")).toBe(false)
  })

  it("rejects a missing directory with ConfigError", () => {
    const error = Effect.runSync(Effect.flip(loadPolicySet(`${POLICY_DIR}/does-not-exist`)))
    expect(error).toBeInstanceOf(ConfigError)
  })
})

describe("inheritance", () => {
  it("gives a child the parent rules plus its own", () => {
    const set = Effect.runSync(
      compilePolicies({
        default: DEFAULT,
        dev: `rules:\n  - { bot: "*", tool: "Bash(git push origin main)", effect: allow }\n`,
      }),
    )
    const dev = set.rulesOf("dev") ?? []
    expect(dev.map((r) => r.rule.tool)).toEqual([
      "Read(.env*)",
      "Bash(git status)",
      "Bash(git push origin main)",
    ])
  })

  it("lets a child replace a parent rule with the same key", () => {
    const set = Effect.runSync(
      compilePolicies({
        default: DEFAULT,
        dev: `rules:\n  - { bot: "*", tool: "Bash(git status)", effect: ask }\n`,
      }),
    )
    const dev = set.rulesOf("dev") ?? []
    expect(dev.find((r) => r.rule.tool === "Bash(git status)")?.rule.effect).toBe("ask")
    expect(dev).toHaveLength(2)
  })

  it("resolves a chain of parents", () => {
    const set = Effect.runSync(
      compilePolicies({
        default: DEFAULT,
        team: `extends: default\nrules:\n  - { bot: "*", tool: "Bash(make test)", effect: allow }\n`,
        dev: `extends: team\n`,
      }),
    )
    expect(set.rulesOf("dev")?.map((r) => r.rule.tool)).toEqual([
      "Read(.env*)",
      "Bash(git status)",
      "Bash(make test)",
    ])
  })

  it("rejects an inheritance cycle with a clear message", () => {
    const error = failure({
      default: DEFAULT,
      a: `extends: b\n`,
      b: `extends: a\n`,
    })
    expect(error.message).toContain("inheritance cycle")
    expect(error.message).toContain("a -> b -> a")
  })

  it("rejects a self-extending policy", () => {
    expect(failure({ default: DEFAULT, a: `extends: a\n` }).message).toContain("inheritance cycle")
  })

  it("rejects a parent that does not exist", () => {
    expect(failure({ default: DEFAULT, dev: `extends: missing\n` }).message).toContain("policy not found")
  })

  it("rejects default extending another policy", () => {
    expect(failure({ default: `extends: dev\n`, dev: DEFAULT }).message).toContain("default cannot extend")
  })

  it("requires a default policy", () => {
    expect(failure({ dev: DEFAULT }).message).toContain("default policy file is missing")
  })
})

describe("validation at load", () => {
  it("rejects an allow rule that covers an irreversible action", () => {
    const cases = [
      "Bash",
      "Bash(*)",
      "Bash(rm -rf *)",
      "Bash(git push *)",
      "Bash(git push origin *)",
      "Bash(docker *)",
      "Bash(psql *)",
      "*",
      "stripe.*",
      "email.send",
      "deploy.*",
    ]
    for (const tool of cases) {
      const error = failure({
        default: DEFAULT,
        dev: `rules:\n  - { bot: "*", tool: "${tool}", effect: allow }\n`,
      })
      expect(error.message, tool).toContain("irreversible")
    }
  })

  it("accepts an allow rule that is narrow enough", () => {
    const result = load({
      default: DEFAULT,
      dev: `rules:\n  - { bot: "*", tool: "Bash(git push origin main)", effect: allow }\n  - { bot: "*", tool: "Bash(pnpm test)", effect: allow }\n`,
    })
    expect(result._tag).toBe("Success")
  })

  it("accepts irreversible patterns in deny and ask rules", () => {
    const result = load({
      default: DEFAULT,
      dev: `rules:\n  - { bot: "*", tool: "Bash(rm -rf *)", effect: deny }\n  - { bot: "*", tool: "stripe.*", effect: ask }\n`,
    })
    expect(result._tag).toBe("Success")
  })

  it("rejects shell syntax in a Bash pattern", () => {
    for (const tool of [
      "Bash(git push; rm -rf *)",
      "Bash(git $(rm))",
      'Bash("git push")',
      "Bash(git | sh)",
    ]) {
      expect(
        failure({ default: DEFAULT, dev: `rules:\n  - { bot: "*", tool: '${tool}', effect: deny }\n` })
          .message,
        tool,
      ).toMatch(/plain words|invalid tool pattern/)
    }
  })

  it("rejects a malformed tool pattern", () => {
    expect(
      failure({ default: DEFAULT, dev: `rules:\n  - { bot: "*", tool: "Bash(git", effect: deny }\n` })
        .message,
    ).toContain("invalid tool pattern")
    expect(
      failure({ default: DEFAULT, dev: `rules:\n  - { bot: "*", tool: "Bash()", effect: deny }\n` }).message,
    ).toContain("invalid tool pattern")
  })

  it("rejects an effect outside allow, ask and deny", () => {
    const error = failure({
      default: DEFAULT,
      dev: `rules:\n  - { bot: "*", tool: "Read", effect: maybe }\n`,
    })
    expect(error.key).toBe("dev")
  })

  it("rejects a misspelled key instead of ignoring it", () => {
    const error = failure({ default: DEFAULT, dev: `rules:\n  - { bot: "*", tool: "Read", effct: deny }\n` })
    expect(error.key).toBe("dev")
  })

  it("rejects invalid YAML", () => {
    expect(failure({ default: DEFAULT, dev: "rules: [\n" }).message).toContain("invalid YAML")
  })

  it("rejects a bot id that is neither a BotId nor *", () => {
    expect(
      failure({ default: DEFAULT, dev: `rules:\n  - { bot: "alice", tool: "Read", effect: deny }\n` }).key,
    ).toBe("dev")
  })

  it("rejects a policy file name that is not lowercase", () => {
    expect(failure({ default: DEFAULT, Dev: DEFAULT }).message).toContain("lowercase")
  })
})
