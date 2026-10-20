import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { ConfigError, PolicyRule, type ToolCall } from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import { parse } from "yaml"
import { globMatch, parseArgvPattern, parseToolPattern } from "./match.js"
import { IRREVERSIBLE_PROBES, riskOf } from "./risk.js"
import { type CompiledRule, contextOf, ruleLabel, ruleMatches } from "./rule.js"
import { WRAPPER_HEADS } from "./unwrap.js"

export const DEFAULT_POLICY = "default"
const FILE_SUFFIX = ".yaml"

export interface PolicySet {
  readonly rulesOf: (name: string) => ReadonlyArray<CompiledRule> | undefined
}

const PolicyName = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/))

// One YAML file. Unknown keys are errors (decode option), so a typo like "effct" cannot pass silently.
const PolicyFile = Schema.Struct({
  extends: Schema.optionalKey(PolicyName),
  rules: Schema.optionalKey(Schema.Array(PolicyRule)),
})
type PolicyFile = typeof PolicyFile.Type

const configError = (key: string, message: string): ConfigError => new ConfigError({ key, message })

const describeCause = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

const decodeFile = (name: string, text: string): Effect.Effect<PolicyFile, ConfigError> =>
  Effect.gen(function* () {
    const raw = yield* Effect.try({
      try: (): unknown => parse(text),
      catch: (cause) => configError(name, `invalid YAML: ${describeCause(cause)}`),
    })
    return yield* Schema.decodeUnknownEffect(PolicyFile, { onExcessProperty: "error" })(raw).pipe(
      Effect.mapError((e) => configError(name, `invalid policy: ${e.message}`)),
    )
  })

// Same (bot, tool, resource) key: the child's rule replaces the parent's. Other parent rules stay.
// A deny is a floor: a child cannot replace an inherited deny with anything else.
const ruleKey = (rule: PolicyRule): string => JSON.stringify([rule.bot, rule.tool, rule.resource ?? null])

const overrideByKey = (
  name: string,
  base: ReadonlyArray<PolicyRule>,
  own: ReadonlyArray<PolicyRule>,
): Effect.Effect<ReadonlyArray<PolicyRule>, ConfigError> =>
  Effect.gen(function* () {
    const merged = new Map<string, PolicyRule>()
    for (const rule of base) {
      merged.set(ruleKey(rule), rule)
    }
    for (const rule of own) {
      const inherited = merged.get(ruleKey(rule))
      if (inherited?.effect === "deny" && rule.effect !== "deny") {
        return yield* Effect.fail(
          configError(name, `cannot weaken inherited deny "${inherited.tool}" to ${rule.effect}`),
        )
      }
      merged.set(ruleKey(rule), rule)
    }
    return [...merged.values()]
  })

// Load-time guard: an allow rule that matches an irreversible probe (literal or normalized command) is rejected.
// The runtime guard in decide() also asks for irreversible calls, so this is the early, explicit failure.
const allowCoversIrreversible = (compiled: CompiledRule): ToolCall | undefined =>
  IRREVERSIBLE_PROBES.find((probe) => {
    const ctx = contextOf(probe)
    return riskOf(probe) === "irreversible" && ruleMatches(compiled, compiled.rule.bot, ctx, "probe")
  })

const compileRule = (
  name: string,
  rule: PolicyRule,
  index: number,
): Effect.Effect<CompiledRule, ConfigError> =>
  Effect.gen(function* () {
    const where = `${name}.rules[${index}]`
    const pattern = parseToolPattern(rule.tool)
    if (pattern === undefined) {
      return yield* Effect.fail(configError(where, `invalid tool pattern "${rule.tool}"`))
    }
    let argv: ReadonlyArray<string> | undefined
    let path: string | undefined
    if (pattern.spec !== undefined) {
      if (pattern.name === "Bash") {
        argv = parseArgvPattern(pattern.spec)
        if (argv === undefined) {
          return yield* Effect.fail(
            configError(
              where,
              "Bash pattern takes plain words and * only: no operators, quotes or expansions",
            ),
          )
        }
      } else {
        path = pattern.spec
      }
    }
    const head = argv?.[0]
    if (rule.effect === "allow" && head !== undefined && head !== "*") {
      const wrapper = WRAPPER_HEADS.find((name) => globMatch(head, name, false))
      if (wrapper !== undefined) {
        return yield* Effect.fail(
          configError(
            where,
            `allow on wrapper head "${head}" would reach irreversible actions; wrappers are never allowed`,
          ),
        )
      }
    }
    const compiled: CompiledRule = { rule, label: ruleLabel(rule), index, toolName: pattern.name, argv, path }
    if (rule.effect === "allow") {
      const probe = allowCoversIrreversible(compiled)
      if (probe !== undefined) {
        return yield* Effect.fail(
          configError(
            where,
            `allow reaches an irreversible action (${probe.tool}); irreversible actions always ask`,
          ),
        )
      }
    }
    return compiled
  })

const mergedRules = (
  files: ReadonlyMap<string, PolicyFile>,
  name: string,
  stack: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<PolicyRule>, ConfigError> =>
  Effect.gen(function* () {
    if (stack.includes(name)) {
      return yield* Effect.fail(configError(name, `inheritance cycle: ${[...stack, name].join(" -> ")}`))
    }
    const file = files.get(name)
    if (file === undefined) {
      return yield* Effect.fail(configError(name, "policy not found"))
    }
    if (name === DEFAULT_POLICY) {
      if (file.extends !== undefined) {
        return yield* Effect.fail(configError(name, "default cannot extend another policy"))
      }
      return yield* overrideByKey(name, [], file.rules ?? [])
    }
    const parent = file.extends ?? DEFAULT_POLICY
    const base = yield* mergedRules(files, parent, [...stack, name])
    return yield* overrideByKey(name, base, file.rules ?? [])
  })

// Pure: name → YAML text to a set of compiled rules, with inheritance resolved. Every error is a ConfigError.
export const compilePolicies = (
  sources: Readonly<Record<string, string>>,
): Effect.Effect<PolicySet, ConfigError> =>
  Effect.gen(function* () {
    const texts = new Map(Object.entries(sources))
    if (!texts.has(DEFAULT_POLICY)) {
      return yield* Effect.fail(configError(DEFAULT_POLICY, "default policy file is missing"))
    }
    const files = new Map<string, PolicyFile>()
    for (const [name, text] of texts) {
      if (!Schema.is(PolicyName)(name)) {
        return yield* Effect.fail(
          configError(name, "policy name must be lowercase letters, digits and dashes"),
        )
      }
      files.set(name, yield* decodeFile(name, text))
    }
    const compiled = new Map<string, ReadonlyArray<CompiledRule>>()
    for (const name of files.keys()) {
      const rules = yield* mergedRules(files, name, [])
      const list = yield* Effect.forEach(rules, (rule, index) => compileRule(name, rule, index))
      compiled.set(name, list)
    }
    return { rulesOf: (name: string) => compiled.get(name) }
  })

// Reads every *.yaml in the directory. The path comes from the composition root; this package never reads env.
export const loadPolicySet = (dir: string): Effect.Effect<PolicySet, ConfigError> =>
  Effect.gen(function* () {
    const entries = yield* Effect.try({
      try: (): ReadonlyArray<string> => readdirSync(dir),
      catch: (cause) => configError(dir, `cannot list policy directory: ${describeCause(cause)}`),
    })
    const sources: Record<string, string> = {}
    for (const entry of entries) {
      if (!entry.endsWith(FILE_SUFFIX)) {
        continue
      }
      const name = entry.slice(0, -FILE_SUFFIX.length)
      sources[name] = yield* Effect.try({
        try: () => readFileSync(join(dir, entry), "utf8"),
        catch: (cause) => configError(join(dir, entry), `cannot read policy file: ${describeCause(cause)}`),
      })
    }
    return yield* compilePolicies(sources)
  })
