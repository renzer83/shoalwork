import type { PolicyRule, ToolCall } from "@shoalwork/contracts"
import { Schema } from "effect"
import { argvMatch, globMatch } from "./match.js"
import { commandOf } from "./risk.js"
import { expandCommand, normalizedArgv } from "./unwrap.js"

// A rule after loading: the YAML rule plus its parsed tool pattern. Built only by the loader.
export interface CompiledRule {
  readonly rule: PolicyRule
  readonly label: string
  // Position in the merged list (parent rules first); last tie-break after label.
  readonly index: number
  readonly toolName: string
  // Bash(...) words. Undefined when the rule has no spec or the tool is not Bash.
  readonly argv: ReadonlyArray<string> | undefined
  // Other(...) path glob, matched against the call's resources. Undefined when absent.
  readonly path: string | undefined
}

export interface BashContext {
  readonly compound: boolean
  // Top-level commands, literal (used by allow).
  readonly literal: ReadonlyArray<ReadonlyArray<string>>
  // Every command that may run, normalized (basename head, git options removed): used by deny and ask.
  readonly normalized: ReadonlyArray<ReadonlyArray<string>>
  // Non-wrapper commands only, normalized: the load-time probe check. A wrapper is judged by its inner command.
  readonly leaves: ReadonlyArray<ReadonlyArray<string>>
}

export interface MatchContext {
  readonly call: ToolCall
  readonly bash: BashContext | undefined
}

// allow: literal argv, and every resource must match. restrict (deny, ask): every command, any resource.
// probe: load-time check, literal or normalized, any resource.
export type MatchMode = "allow" | "restrict" | "probe"

export const ruleLabel = (rule: PolicyRule): string =>
  `${rule.effect} ${rule.bot} ${rule.tool}${rule.resource === undefined ? "" : ` [${rule.resource}]`}`

const PATH_INPUT = Schema.Struct({
  file_path: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.String),
  pattern: Schema.optionalKey(Schema.String),
  notebook_path: Schema.optionalKey(Schema.String),
  glob: Schema.optionalKey(Schema.String),
})

// Every string a rule could be asked about: the explicit resource and each path-like input field.
// Bash has no path fields; its resource is call.resource only.
export const resourcesOf = (call: ToolCall): ReadonlyArray<string> => {
  const out: string[] = []
  if (call.resource !== undefined) {
    out.push(call.resource)
  }
  if (call.tool !== "Bash" && Schema.is(PATH_INPUT)(call.input)) {
    for (const value of [
      call.input.file_path,
      call.input.path,
      call.input.pattern,
      call.input.notebook_path,
      call.input.glob,
    ]) {
      if (value !== undefined) {
        out.push(value)
      }
    }
  }
  return out
}

export const contextOf = (call: ToolCall): MatchContext => {
  const command = call.tool === "Bash" ? commandOf(call.input) : undefined
  if (command === undefined) {
    return { call, bash: undefined }
  }
  const expansion = expandCommand(command)
  return {
    call,
    bash: {
      compound: expansion.compound,
      literal: expansion.outer.map((s) => s.argv),
      normalized: expansion.nodes.map((n) => normalizedArgv(n.argv)),
      leaves: expansion.nodes.filter((n) => !n.wrapper).map((n) => normalizedArgv(n.argv)),
    },
  }
}

const botMatches = (rule: PolicyRule, botId: string): boolean => rule.bot === "*" || rule.bot === botId

const resourceMatches = (pattern: string, call: ToolCall, mode: MatchMode): boolean => {
  const candidates = resourcesOf(call).map((c) => c.toLowerCase())
  if (candidates.length === 0) {
    return false
  }
  const glob = pattern.toLowerCase()
  const hit = (candidate: string): boolean => globMatch(glob, candidate, true)
  return mode === "allow" ? candidates.every(hit) : candidates.some(hit)
}

export const ruleMatches = (
  compiled: CompiledRule,
  botId: string,
  ctx: MatchContext,
  mode: MatchMode,
): boolean => {
  if (!botMatches(compiled.rule, botId) || !globMatch(compiled.toolName, ctx.call.tool, false)) {
    return false
  }
  if (compiled.argv !== undefined) {
    const bash = ctx.bash
    if (bash === undefined) {
      return false
    }
    const argvs = mode === "allow" ? bash.literal : mode === "restrict" ? bash.normalized : bash.leaves
    const words = compiled.argv
    if (!argvs.some((argv) => argvMatch(words, argv))) {
      return false
    }
  }
  if (compiled.path !== undefined && !resourceMatches(compiled.path, ctx.call, mode)) {
    return false
  }
  if (compiled.rule.resource !== undefined && !resourceMatches(compiled.rule.resource, ctx.call, mode)) {
    return false
  }
  return true
}

const literalLength = (text: string): number => [...text].filter((c) => c !== "*").length

// Most specific first: exact bot, then longer literal tool text, then a resource glob, then longer literal
// resource. Ties go to the label, then to the position in the merged list, so the result is deterministic.
const specificityOf = (c: CompiledRule): ReadonlyArray<number> => [
  c.rule.bot === "*" ? 0 : 1,
  literalLength(c.rule.tool),
  c.rule.resource === undefined ? 0 : 1,
  c.rule.resource === undefined ? 0 : literalLength(c.rule.resource),
]

const compareSpecificity = (a: CompiledRule, b: CompiledRule): number => {
  const sa = specificityOf(a)
  const sb = specificityOf(b)
  for (let i = 0; i < sa.length; i++) {
    const diff = (sb[i] ?? 0) - (sa[i] ?? 0)
    if (diff !== 0) {
      return diff
    }
  }
  if (a.label !== b.label) {
    return a.label < b.label ? -1 : 1
  }
  return a.index - b.index
}

export const mostSpecific = (list: ReadonlyArray<CompiledRule>): CompiledRule | undefined =>
  list.length === 0 ? undefined : [...list].sort(compareSpecificity)[0]
