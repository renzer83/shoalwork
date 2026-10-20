import type {
  Bot,
  ExecutorId,
  ExecutorTask,
  PermissionMode,
  PolicyRule,
  StepId,
  TaskSpec,
} from "@shoalwork/contracts"
import { type ExecutorContext, REEF_MCP_TOOLS } from "@shoalwork/executors"
import { Policy } from "@shoalwork/policy"
import { Effect, Option } from "effect"
import { withBridgeMode } from "./executor-task.js"

// What a run may do without asking, derived from the Bot's policy (T-057). allowedTools only ever narrows what the
// Policy would allow: a rule whose Claude Code form could reach anything the Policy denies, asks or deems irreversible
// is left out, so that call goes to the Policy (through the permission bridge) instead.
export interface DerivedPermission {
  readonly permissionMode: PermissionMode
  readonly allowedTools: ReadonlyArray<string>
}

// Plain tool names only: a glob name ("*Edit", "mcp__x__*") has no Claude Code form that is exact.
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_]*$/
// Literal Bash words: no shell syntax, no quotes, no operators, no "*".
const BASH_WORD = /^[A-Za-z0-9_./=@+-]+$/

const escapeRegex = (text: string): string => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&")

// Whether two names or heads could match the same text: equal, or one of them is a "*" glob that matches the other.
const mayMatch = (a: string, b: string): boolean => {
  if (a === b) return true
  const glob = a.includes("*") ? a : b.includes("*") ? b : undefined
  const text = glob === a ? b : a
  if (glob === undefined) return false
  return new RegExp(`^${glob.split("*").map(escapeRegex).join(".*")}$`).test(text)
}

const nameOf = (tool: string): string => {
  const open = tool.indexOf("(")
  return open === -1 ? tool : tool.slice(0, open)
}

// The first word of a Bash rule. Undefined for a rule with no spec, which covers every head of that tool.
const headOf = (tool: string): string | undefined => {
  const open = tool.indexOf("(")
  if (open === -1) return undefined
  return tool
    .slice(open + 1, -1)
    .trim()
    .split(/\s+/)[0]
}

// A deny or ask rule that could cover what an allow rule covers. A rule with a resource covers the whole tool name.
const overlaps = (allow: PolicyRule, other: PolicyRule): boolean => {
  if (!mayMatch(nameOf(allow.tool), nameOf(other.tool))) return false
  if (other.resource !== undefined) return true
  const allowHead = headOf(allow.tool)
  const otherHead = headOf(other.tool)
  if (allowHead === undefined || otherHead === undefined) return true
  return mayMatch(allowHead, otherHead)
}

// Claude Code form of an allow rule, or undefined when it is not an exact form. Only these are derived:
//   "Read"            -> "Read"
//   "Bash(npm test)"  -> "Bash(npm test)"
//   "Bash(npm test *)" and any rule with "*", a resource, or shell syntax -> undefined (stays with the Policy).
// Why: how the CLI matches a wildcard rule, command substitution, redirection and newlines is not verified yet
// (live probe, T-166). Until it is, a wildcard in allowedTools could widen the Policy in ways nobody has measured.
export const toClaudeRule = (rule: PolicyRule): string | undefined => {
  if (rule.resource !== undefined) return undefined
  const open = rule.tool.indexOf("(")
  if (open === -1) return TOOL_NAME.test(rule.tool) ? rule.tool : undefined
  if (!rule.tool.endsWith(")") || nameOf(rule.tool) !== "Bash") return undefined
  const words = rule.tool
    .slice(open + 1, -1)
    .trim()
    .split(/\s+/)
  if (!words.every((word) => BASH_WORD.test(word))) return undefined
  return `Bash(${words.join(" ")})`
}

// The permissions of a run of this Bot. `rules` are the rules of the Bot's policy (Policy.rulesOf); the mode is "edit"
// here, and "auto" is set by withBridgeMode when the run has the permission bridge (T-177). "bypass" is never derived:
// irreversible calls always ask, so no set of allow rules can cover every tool the Policy has to judge.
export const derivePermission = (
  bot: Pick<Bot, "id">,
  rules: ReadonlyArray<PolicyRule>,
): DerivedPermission => {
  const mine = rules.filter((rule) => rule.bot === "*" || rule.bot === bot.id)
  const restricting = mine.filter((rule) => rule.effect !== "allow")
  const allowed = mine.flatMap((rule) => {
    if (rule.effect !== "allow") return []
    const claude = toClaudeRule(rule)
    if (claude === undefined || restricting.some((other) => overlaps(rule, other))) return []
    return [claude]
  })
  return { permissionMode: "edit", allowedTools: [...new Set(allowed)] }
}

// The permissions of a run, read through the Policy when the core has one. Without it nothing is pre-approved.
export const permissionOf = (bot: Pick<Bot, "id">): Effect.Effect<DerivedPermission> =>
  Effect.gen(function* () {
    const policy = Option.getOrUndefined(yield* Effect.serviceOption(Policy))
    return derivePermission(bot, policy === undefined ? [] : yield* policy.rulesOf(bot.id))
  })

// The audit of a run's executor.started (T-057): the mode and the tools the CLI gets. The bridge may raise the mode to
// "auto" (T-177). With an MCP config the Claude Code adapter adds the reef tools (args.ts), so they are listed too.
export const startedPayload = (input: {
  readonly spec: Pick<TaskSpec, "id">
  readonly bot: Pick<Bot, "id">
  readonly stepId: StepId
  readonly executor: ExecutorId
  readonly model: string
  readonly task: ExecutorTask
  readonly context: ExecutorContext
}) => {
  const effective = withBridgeMode(input.task, input.context)
  const reef = input.executor === "claude-code" && input.context.mcp !== undefined
  const tools = reef ? [...effective.allowedTools, ...REEF_MCP_TOOLS] : effective.allowedTools
  return {
    taskId: input.spec.id,
    stepId: input.stepId,
    botId: input.bot.id,
    executor: input.executor,
    model: input.model,
    cwd: input.context.cwd,
    permissionMode: effective.permissionMode,
    allowedTools: [...new Set(tools)],
  }
}

// Records executor.started through the given event writer (the Lead's taskEvent).
export const recordStarted = (
  emit: (
    taskId: Pick<TaskSpec, "id">["id"],
    type: "executor.started",
    payload: unknown,
  ) => Effect.Effect<unknown, unknown>,
  input: Parameters<typeof startedPayload>[0],
) => emit(input.spec.id, "executor.started", startedPayload(input))
