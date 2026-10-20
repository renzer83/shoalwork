import { createHash } from "node:crypto"
import {
  type Artifact,
  type Budget,
  type ExecutorErrorCode,
  type ModelTier,
  type Risk,
  type SessionId,
  type StepId,
  StepId as StepIdSchema,
  type TaskId,
  type TaskSpec,
  type TaskState,
  type ToolCall,
  type Usage,
  type Verdict,
  ZERO_USAGE,
} from "@shoalwork/contracts"
import { Schema } from "effect"

export const REAPED_EVIDENCE = "reaped: max attempts"
export const ACTOR = "system:lead"
export const SUMMARY_MAX = 2000
export const EVIDENCE_MAX = 500

// One step id (so one worktree and one branch) per attempt: the worktree an earlier attempt left behind for
// diagnosis must not collide with the next attempt. Deterministic, uuid-shaped as the StepId contract requires.
export const stepIdFor = (taskId: TaskId, attempt: number): StepId => {
  const hex = createHash("sha256").update(`${taskId}:attempt:${attempt}`).digest("hex")
  const uuid = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-")
  return Schema.decodeUnknownSync(StepIdSchema)(`step_${uuid}`)
}

export const buildPrompt = (spec: Pick<TaskSpec, "prompt" | "acceptance">): string =>
  spec.acceptance.length === 0
    ? spec.prompt
    : `${spec.prompt}\n\nAcceptance:\n${spec.acceptance.map((line) => `- ${line}`).join("\n")}`

// Git/gh steps the Lead runs after an ok run of a code task (git-delivery.ts).
export type DeliveryStep = "commit" | "push" | "pr"

// What the executor stream (or the machinery around it) ended with.
export type Outcome =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Done"; readonly result: string }
  | { readonly _tag: "ExecutorError"; readonly code: ExecutorErrorCode; readonly message: string }
  | { readonly _tag: "Approval"; readonly action: ToolCall; readonly risk: Risk }
  | { readonly _tag: "Channel"; readonly tag: string; readonly executor: string }
  | { readonly _tag: "Failure"; readonly tag: string; readonly message: string }
  | { readonly _tag: "TimedOut" }
  // The task's own budget (scope task) or its Bot's rolling window (scope bot) was exceeded; `used` is what counted.
  | {
      readonly _tag: "BudgetExceeded"
      readonly scope: "task" | "bot"
      readonly limit: Budget
      readonly used: Budget
    }
  // A person (or the watchdog) stopped the task: `by` says who.
  | { readonly _tag: "Stopped"; readonly by: string }
  | { readonly _tag: "Delivery"; readonly step: DeliveryStep; readonly message: string }
  // No executor serves the task's tier (override, table and alternatives all unavailable).
  | { readonly _tag: "NoExecutor"; readonly tier: ModelTier }

export interface Progress {
  readonly usage: Usage
  readonly sessionId: SessionId | undefined
  readonly stepId: StepId | undefined
  readonly outcome: Outcome
  // Artifacts the Lead produced itself (the PR of a delivered code task).
  readonly artifacts: ReadonlyArray<Artifact>
  // tasks.attempts when this run started: 1 for the first run of the task.
  readonly attempt: number
  // Executor events handled in this run (a resume that fails at once is recognised by this).
  readonly events: number
  // Text of the last text event: the tail the next attempt starts from.
  readonly lastText: string
}

export const withOutcome =
  (outcome: Outcome) =>
  (p: Progress): Progress => ({ ...p, outcome })

export const withArtifact =
  (artifact: Artifact) =>
  (p: Progress): Progress => ({ ...p, artifacts: [...p.artifacts, artifact] })

export const INITIAL: Progress = {
  usage: ZERO_USAGE,
  sessionId: undefined,
  stepId: undefined,
  outcome: { _tag: "Pending" },
  artifacts: [],
  attempt: 0,
  events: 0,
  lastText: "",
}

export const clip = (text: string, max: number): string => (text.length > max ? text.slice(0, max) : text)

export const verdictFor = (progress: Progress, seconds: number): Verdict => {
  const cost = {
    tokensIn: progress.usage.tokensIn,
    tokensOut: progress.usage.tokensOut,
    usd: progress.usage.usd,
    seconds,
  }
  const base = { cost, ...(progress.sessionId === undefined ? {} : { sessionId: progress.sessionId }) }
  const outcome = progress.outcome
  switch (outcome._tag) {
    case "Done":
      return {
        kind: "ok",
        summary: clip(outcome.result, SUMMARY_MAX),
        evidence: progress.artifacts.map((artifact) => clip(artifact.ref, EVIDENCE_MAX)),
        ...base,
      }
    case "Delivery":
      return {
        kind: "failed",
        summary: clip(`delivery failed at ${outcome.step}: ${outcome.message}`, SUMMARY_MAX),
        evidence: [`delivery: ${outcome.step}`],
        ...base,
      }
    case "ExecutorError": {
      // budget: the CLI stopped on its own limit. protocol/spawn/auth: environment problems a retry will not fix.
      const kind =
        outcome.code === "budget"
          ? "budget_exceeded"
          : outcome.code === "max_turns" || outcome.code === "unknown"
            ? "failed"
            : "blocked"
      return {
        kind,
        summary: clip(outcome.message, SUMMARY_MAX),
        evidence: [`executor error code: ${outcome.code}`],
        ...base,
      }
    }
    case "NoExecutor":
      return {
        kind: "blocked",
        summary: clip(`no executor available for tier ${outcome.tier}`, SUMMARY_MAX),
        evidence: [`no executor available for tier ${outcome.tier}`],
        ...base,
      }
    case "Approval":
      return {
        kind: "needs_approval",
        summary: clip(`approval needed for ${outcome.action.tool} (risk: ${outcome.risk})`, SUMMARY_MAX),
        evidence: outcome.action.resource === undefined ? [] : [clip(outcome.action.resource, EVIDENCE_MAX)],
        ...base,
      }
    case "Channel":
      return {
        kind: "blocked",
        summary: clip(`executor ${outcome.executor} failed: ${outcome.tag}`, SUMMARY_MAX),
        evidence: [outcome.tag],
        ...base,
      }
    case "Failure":
      return {
        kind: "blocked",
        summary: clip(`${outcome.tag}: ${outcome.message}`, SUMMARY_MAX),
        evidence: [outcome.tag],
        ...base,
      }
    case "TimedOut":
      return { kind: "budget_exceeded", summary: "task exceeded its time budget", evidence: [], ...base }
    case "BudgetExceeded":
      return {
        kind: "budget_exceeded",
        summary: `${outcome.scope} budget exceeded`,
        evidence: [`budget scope: ${outcome.scope}`],
        ...base,
      }
    case "Stopped":
      return {
        kind: "blocked",
        summary: clip(`stopped by ${outcome.by}`, SUMMARY_MAX),
        evidence: [clip(`stopped by ${outcome.by}`, EVIDENCE_MAX)],
        ...base,
      }
    case "Pending":
      return {
        kind: "blocked",
        summary: "executor stream ended without a terminal event",
        evidence: ["protocol"],
        ...base,
      }
  }
}

const isTagged = (u: unknown): u is { readonly _tag: string } =>
  typeof u === "object" && u !== null && "_tag" in u && typeof u._tag === "string"

// Short, secret-free description of any failure: the tag plus the message or the tank operation, never raw output.
export const describeFailure = (u: unknown): { readonly tag: string; readonly message: string } => {
  const tag = isTagged(u) ? u._tag : u instanceof Error ? u.name : "Defect"
  if (u instanceof Error && u.message !== "") {
    return { tag, message: clip(u.message, EVIDENCE_MAX) }
  }
  if (typeof u === "object" && u !== null && "op" in u && typeof u.op === "string") {
    return { tag, message: clip(u.op, EVIDENCE_MAX) }
  }
  return { tag, message: "no further detail" }
}

export const finalTaskState = (verdict: Verdict): TaskState =>
  verdict.kind === "ok" ? "done" : verdict.kind === "needs_approval" ? "waiting_approval" : "failed"

export const isSettled = (state: TaskState): boolean =>
  state === "done" || state === "failed" || state === "cancelled" || state === "waiting_approval"

export const blockedVerdict = (summary: string, tag: string): Verdict => ({
  kind: "blocked",
  summary,
  evidence: [tag],
  cost: { tokensIn: 0, tokensOut: 0, usd: 0, seconds: 0 },
})

export const stoppedVerdict = (by: string): Verdict => ({
  kind: "blocked",
  summary: `stopped by ${by}`,
  evidence: [`stopped by ${by}`],
  cost: { tokensIn: 0, tokensOut: 0, usd: 0, seconds: 0 },
})

export const isNotFound = (u: unknown): boolean => isTagged(u) && u._tag === "NotFound"
