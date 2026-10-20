import { Beacon, type BeaconShape } from "@shoalwork/beacon"
import {
  type BotId,
  type ConfigError,
  newEventId,
  type PolicyDecision,
  type PolicyEffect,
  type Risk,
  streamIds,
  type ToolCall,
} from "@shoalwork/contracts"
import { Context, Effect, Layer, Ref } from "effect"
import { compilePolicies, DEFAULT_POLICY, loadPolicySet, type PolicySet } from "./loader.js"
import { DEFAULT_MAX_INPUT_BYTES, inputTooLarge, riskOf } from "./risk.js"
import { type CompiledRule, contextOf, type MatchMode, mostSpecific, ruleLabel, ruleMatches } from "./rule.js"
import { isWriteOutsideWorkspace } from "./workspace.js"

const decisionOf = (effect: PolicyEffect, rule: CompiledRule | undefined, risk: Risk): PolicyDecision =>
  rule === undefined ? { effect, risk } : { effect, rule: rule.rule, risk }

// deny -> ask -> allow, then workspace, then risk. Compound, wrapped or remote Bash, irreversible calls and
// writes outside the workspace are never allowed. A call over the input cap is asked before any lexing.
export const decide = (
  rules: ReadonlyArray<CompiledRule>,
  botId: string,
  call: ToolCall,
  roots: ReadonlyArray<string> = [],
  maxBytes = DEFAULT_MAX_INPUT_BYTES,
): PolicyDecision => {
  if (inputTooLarge(call, maxBytes) !== undefined) {
    return { effect: "ask", risk: "irreversible" }
  }
  const risk = riskOf(call, maxBytes)
  const ctx = contextOf(call)
  const applicable = (effect: PolicyEffect, mode: MatchMode): ReadonlyArray<CompiledRule> =>
    rules.filter((r) => r.rule.effect === effect && ruleMatches(r, botId, ctx, mode))

  const deny = mostSpecific(applicable("deny", "restrict"))
  if (deny !== undefined) {
    return decisionOf("deny", deny, risk)
  }
  const ask = mostSpecific(applicable("ask", "restrict"))
  if (ask !== undefined) {
    return decisionOf("ask", ask, risk)
  }
  if (isWriteOutsideWorkspace(call, roots)) {
    return decisionOf("ask", undefined, risk)
  }
  const compound = ctx.bash?.compound ?? false
  const unknownBash = call.tool === "Bash" && ctx.bash === undefined
  if (risk === "irreversible" || compound || unknownBash) {
    return decisionOf("ask", undefined, risk)
  }
  const allow = mostSpecific(applicable("allow", "allow"))
  if (allow !== undefined) {
    return decisionOf("allow", allow, risk)
  }
  if (risk === "read" || risk === "write_local") {
    return { effect: "allow", risk }
  }
  return { effect: "ask", risk }
}

// Per-call workspace: the cwd or worktree of the run, and any extra roots (e.g. the Bot's home in the Tank).
export interface EvaluationContext {
  readonly cwd?: string
  readonly roots?: ReadonlyArray<string>
}

export interface PolicyShape {
  readonly evaluate: (
    botId: BotId,
    call: ToolCall,
    context?: EvaluationContext,
  ) => Effect.Effect<PolicyDecision, never>
  readonly riskOf: (call: ToolCall) => Risk
  readonly reload: () => Effect.Effect<void, ConfigError>
}

export class Policy extends Context.Service<Policy, PolicyShape>()("@shoalwork/Policy") {}

export interface PolicyOptions {
  // Policy name for a bot (its `policy:` field). Undefined means "default". An unknown name asks for every call.
  readonly policyOf: (botId: BotId) => string | undefined
  // Workspace roots for writes, fixed for the service. Empty: only relative paths without ".." are placed.
  readonly workspaceRoots?: ReadonlyArray<string>
  // Cap in UTF-8 bytes per Bash command, resource or path-like field. Over it the call is asked at once.
  readonly maxInputBytes?: number
}

export interface PolicyLiveOptions extends PolicyOptions {
  readonly policyDir: string
}

const askFallback = (call: ToolCall): PolicyDecision => ({ effect: "ask", risk: riskOf(call) })

const failClosed = (call: ToolCall, reason: string): Effect.Effect<PolicyDecision> =>
  Effect.logWarning(`policy fell back to ask: ${reason}`).pipe(Effect.as(askFallback(call)))

// Any failure while evaluating becomes ask, never allow.
const evaluateSafely = (
  set: PolicySet,
  policyOf: PolicyOptions["policyOf"],
  botId: BotId,
  call: ToolCall,
  roots: ReadonlyArray<string>,
  maxBytes: number,
): Effect.Effect<PolicyDecision> =>
  Effect.try({
    try: (): PolicyDecision | undefined => {
      const name = policyOf(botId) ?? DEFAULT_POLICY
      const rules = set.rulesOf(name)
      return rules === undefined ? undefined : decide(rules, botId, call, roots, maxBytes)
    },
    catch: (cause): unknown => cause,
  }).pipe(
    Effect.catch((cause) => failClosed(call, cause instanceof Error ? cause.message : "evaluation error")),
    Effect.flatMap((decision) =>
      decision === undefined ? failClosed(call, "unknown policy name") : Effect.succeed(decision),
    ),
  )

const RESOURCE_MAX_CHARS = 200
const SECRET_PAIR =
  /(token|secret|password|passwd|api[_-]?key|authorization|bearer|credential)(\s*[=:]\s*)\S+/gi
const SECRET_TOKEN =
  /(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|AKIA[0-9A-Z]{12,})/g

// Event payloads are stored: drop the query string, mask secret-looking values, cap the length.
export const redactResource = (text: string): string => {
  const query = text.indexOf("?")
  const base = query === -1 ? text : `${text.slice(0, query)}?[redacted]`
  const masked = base.replace(SECRET_PAIR, "$1$2[redacted]").replace(SECRET_TOKEN, "[redacted]")
  return masked.length > RESOURCE_MAX_CHARS ? `${masked.slice(0, RESOURCE_MAX_CHARS)}…` : masked
}

// policy.denied is an event (R12); a failure to record it does not change the decision.
const recordDenied = (
  beacon: BeaconShape,
  botId: BotId,
  call: ToolCall,
  decision: PolicyDecision,
): Effect.Effect<void> =>
  beacon
    .append({
      streamId: streamIds.bot(botId),
      type: "policy.denied",
      payload: {
        botId,
        tool: call.tool,
        ...(call.resource === undefined ? {} : { resource: redactResource(call.resource) }),
        rule: decision.rule === undefined ? "none" : ruleLabel(decision.rule),
      },
      actor: "system:policy",
      correlationId: newEventId(),
    })
    .pipe(
      Effect.asVoid,
      Effect.catch((error) => Effect.logError("policy.denied not recorded", error)),
    )

const rootsFor = (
  base: ReadonlyArray<string>,
  context: EvaluationContext | undefined,
): ReadonlyArray<string> => [
  ...(context?.cwd === undefined ? [] : [context.cwd]),
  ...base,
  ...(context?.roots ?? []),
]

const makePolicy = (deps: {
  readonly beacon: BeaconShape
  readonly state: Ref.Ref<PolicySet>
  readonly policyOf: PolicyOptions["policyOf"]
  readonly workspaceRoots: ReadonlyArray<string>
  readonly maxInputBytes: number
  readonly load: () => Effect.Effect<PolicySet, ConfigError>
}): PolicyShape => ({
  evaluate: (botId, call, context) =>
    Effect.gen(function* () {
      const set = yield* Ref.get(deps.state)
      const roots = rootsFor(deps.workspaceRoots, context)
      const tooLarge = inputTooLarge(call, deps.maxInputBytes)
      if (tooLarge !== undefined) {
        yield* Effect.logWarning(`policy asked without parsing: ${tooLarge}`)
      }
      const decision = yield* evaluateSafely(set, deps.policyOf, botId, call, roots, deps.maxInputBytes)
      if (decision.effect === "deny") {
        yield* recordDenied(deps.beacon, botId, call, decision)
      }
      return decision
    }),
  riskOf: (call) => riskOf(call, deps.maxInputBytes),
  // On failure the previous rules stay active; the error is returned to the caller.
  reload: () => deps.load().pipe(Effect.flatMap((set) => Ref.set(deps.state, set))),
})

// Rules read from disk at construction and on reload(). A broken file fails the layer with ConfigError.
export const makePolicyLive = (options: PolicyLiveOptions): Layer.Layer<Policy, ConfigError, Beacon> =>
  Layer.effect(
    Policy,
    Effect.gen(function* () {
      const beacon = yield* Beacon
      const state = yield* Ref.make(yield* loadPolicySet(options.policyDir))
      return makePolicy({
        beacon,
        state,
        policyOf: options.policyOf,
        workspaceRoots: options.workspaceRoots ?? [],
        maxInputBytes: options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES,
        load: () => loadPolicySet(options.policyDir),
      })
    }),
  )

// Same service over in-memory YAML sources (name → YAML text). For tests and fixtures.
export const makePolicyTest = (
  options: { readonly sources: Readonly<Record<string, string>> } & PolicyOptions,
): Layer.Layer<Policy, ConfigError, Beacon> =>
  Layer.effect(
    Policy,
    Effect.gen(function* () {
      const beacon = yield* Beacon
      const state = yield* Ref.make(yield* compilePolicies(options.sources))
      return makePolicy({
        beacon,
        state,
        policyOf: options.policyOf,
        workspaceRoots: options.workspaceRoots ?? [],
        maxInputBytes: options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES,
        load: () => compilePolicies(options.sources),
      })
    }),
  )
