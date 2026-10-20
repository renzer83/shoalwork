import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk"
import type { BotId, PolicyDecision, Risk, ToolCall } from "@shoalwork/contracts"
import { Effect } from "effect"
import { commandOf, pathsOf, toolNameOf } from "./events.js"

// The Policy of the product, as the adapter needs it: `Policy.evaluate` fits this type.
export type AcpPolicy = (
  botId: BotId,
  call: ToolCall,
  context: { readonly cwd: string; readonly roots: ReadonlyArray<string> },
) => Effect.Effect<PolicyDecision>

export type PermissionOutcome = {
  readonly response: RequestPermissionResponse
  // Set when the policy asks: the adapter reports it as approval_needed and the run pauses (T-054).
  readonly ask?: { readonly action: ToolCall; readonly risk: Risk }
}

const CANCELLED: RequestPermissionResponse = { outcome: { outcome: "cancelled" } }

const RISKS: ReadonlyArray<Risk> = ["read", "write_local", "external", "irreversible"]
const worse = (a: Risk, b: Risk): Risk => (RISKS.indexOf(a) >= RISKS.indexOf(b) ? a : b)

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const stringAt = (raw: unknown, keys: ReadonlyArray<string>): string | undefined => {
  if (!isRecord(raw)) return undefined
  for (const key of keys) {
    const value = raw[key]
    if (typeof value === "string" && value !== "") return value
  }
  return undefined
}

const FILE_KINDS: ReadonlySet<string> = new Set(["read", "search", "fetch", "edit", "move", "delete"])
const DESTINATION_KEYS = ["destination", "dest", "new_path", "newPath", "to", "target"]

// What the policy is asked, or "ask now" when the agent named nothing the policy could judge. Bash and the file
// tools use the same input shapes as the Claude Code tools, so one policy file covers every executor. One call per
// distinct path: the weakest verdict decides, so a path outside the workspace cannot hide behind one inside it.
type Plan =
  | { readonly _tag: "Evaluate"; readonly calls: ReadonlyArray<ToolCall> }
  | { readonly _tag: "AskNow"; readonly action: ToolCall; readonly risk: Risk }

export const planOf = (params: RequestPermissionRequest): Plan => {
  const update = params.toolCall
  const kind = update.kind ?? "other"
  const tool = toolNameOf(kind)
  if (tool === "Bash") {
    const command = commandOf(update.rawInput)
    return { _tag: "Evaluate", calls: [{ tool, input: command === undefined ? {} : { command } }] }
  }
  if (!FILE_KINDS.has(kind)) return { _tag: "Evaluate", calls: [{ tool, input: {} }] }
  const named = pathsOf(update.content, update.locations)
  const fallback = stringAt(update.rawInput, ["path", "file_path", "absolute_path", "url"])
  const destination = kind === "move" ? stringAt(update.rawInput, DESTINATION_KEYS) : undefined
  const targets = Array.from(
    new Set([
      ...(named.length > 0 ? named : fallback === undefined ? [] : [fallback]),
      ...(destination ? [destination] : []),
    ]),
  )
  if (targets.length === 0) return { _tag: "AskNow", action: { tool, input: {} }, risk: "external" }
  // A move names a source and a destination; with one of them missing the policy cannot judge it.
  if (kind === "move" && targets.length < 2) {
    return {
      _tag: "AskNow",
      action: { tool, input: { file_path: targets[0] }, resource: targets[0] },
      risk: "write_local",
    }
  }
  return {
    _tag: "Evaluate",
    calls: targets.map(
      (target): ToolCall =>
        kind === "fetch"
          ? { tool, input: { url: target }, resource: target }
          : { tool, input: { file_path: target }, resource: target },
    ),
  }
}

// Only allow_once / reject_once are used: an "always" option would grant or refuse more than this call. Without the
// right once-option the turn is cancelled, which is a refusal.
const pick = (
  options: ReadonlyArray<PermissionOption>,
  wanted: "allow" | "reject",
): RequestPermissionResponse => {
  const option = options.find((o) => o.kind === `${wanted}_once`)
  return option === undefined ? CANCELLED : { outcome: { outcome: "selected", optionId: option.optionId } }
}

export const handlePermission = (
  deps: {
    readonly botId: BotId
    readonly cwd: string
    readonly roots: ReadonlyArray<string>
    readonly policy: AcpPolicy
  },
  params: RequestPermissionRequest,
): Effect.Effect<PermissionOutcome> =>
  Effect.gen(function* () {
    const plan = planOf(params)
    if (plan._tag === "AskNow") return { response: CANCELLED, ask: { action: plan.action, risk: plan.risk } }
    const decisions = yield* Effect.forEach(plan.calls, (call) =>
      Effect.map(deps.policy(deps.botId, call, { cwd: deps.cwd, roots: deps.roots }), (decision) => ({
        call,
        decision,
      })),
    )
    if (decisions.some((d) => d.decision.effect === "deny"))
      return { response: pick(params.options, "reject") }
    const asks = decisions.filter((d) => d.decision.effect === "ask")
    const first = asks[0]
    // The turn is cancelled: the run ends here and a new one continues after the person decides.
    if (first !== undefined) {
      const risk = asks.reduce((acc, d) => worse(acc, d.decision.risk), first.decision.risk)
      return { response: CANCELLED, ask: { action: first.call, risk } }
    }
    return { response: pick(params.options, "allow") }
  })
