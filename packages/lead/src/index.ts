import { Beacon } from "@shoalwork/beacon"
import { BotRegistry } from "@shoalwork/bots"
import type { TaskId } from "@shoalwork/contracts"
import { GhClient } from "@shoalwork/currents"
import { ExecutorRegistry, type TierConfig } from "@shoalwork/executors"
import { Approvals } from "@shoalwork/policy"
import { Indexer, Ranker, Reef } from "@shoalwork/reef"
import { Tank } from "@shoalwork/tank"
import { Context, Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { Control, makeControl } from "./control.js"
import { MAX_AGENT_MSGS_PER_TASK, makeHandoff } from "./handoff.js"
import { makeIntake } from "./intake.js"
import { Lead, type LeadShape } from "./lead.js"
import { McpTokens, McpTokensLive } from "./mcp-tokens.js"
import { PodNotes } from "./pod-notes.js"
import { DEFAULT_LEAD_CONFIG, type LeadConfig, makeRunner, type RunResult } from "./runner.js"
import { TaskStore, TaskStoreLive } from "./tasks.js"
import { makeWorker } from "./worker.js"

// Settings the composition root reads from the core config and that do not belong to LeadConfig.
export interface LeadOptions {
  // Agent messages a task may carry before further handoffs are refused (T-172, MAX_AGENT_MSGS_PER_TASK).
  readonly maxAgentMsgsPerTask?: number
}

// `tiers` is config/model-tiers.yaml (validated by the composition root): it decides the executor of every task.
export const LeadLive = (
  tiers: TierConfig,
  overrides?: Partial<LeadConfig>,
  options?: LeadOptions,
): Layer.Layer<
  Lead | Control,
  never,
  SqlClient | Beacon | BotRegistry | Tank | GhClient | ExecutorRegistry | TaskStore | McpTokens
> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const beacon = yield* Beacon
      const bots = yield* BotRegistry
      const tank = yield* Tank
      const gh = yield* GhClient
      const executors = yield* ExecutorRegistry
      const tasks = yield* TaskStore
      const tokens = yield* McpTokens
      // Messages from Pod topics wait here for the next round of the task they were meant for (T-175).
      const notes = Option.getOrUndefined(yield* Effect.serviceOption(PodNotes))
      // Without a Reef the briefing has no memories; the rest of it is still delivered.
      const memory = Option.getOrUndefined(yield* Effect.serviceOption(Reef))
      // The repo index feeds the briefing's code block (T-041); without it the briefing carries none.
      const indexer = Option.getOrUndefined(yield* Effect.serviceOption(Indexer))
      // The six-signal ranker (T-096); without it the briefing's code block keeps the search order.
      const ranker = Option.getOrUndefined(yield* Effect.serviceOption(Ranker))
      // Approvals (T-054): without them a task that needs one waits, but nothing can decide it.
      const approvals = Option.getOrUndefined(yield* Effect.serviceOption(Approvals))
      const config: LeadConfig = { ...DEFAULT_LEAD_CONFIG, ...overrides }
      const control = makeControl({ sql, beacon, tasks, bots, stopWaitMs: config.stopWaitMs, approvals })
      const intake = makeIntake({
        sql,
        beacon,
        bots,
        tasks,
        routing: tiers.routing,
        botBudgetWindowMs: config.botBudgetWindowMs,
      })
      const { handoff, reportChild } = makeHandoff({
        beacon,
        bots,
        tasks,
        intake,
        maxMessages: options?.maxAgentMsgsPerTask ?? MAX_AGENT_MSGS_PER_TASK,
      })
      const runner = makeRunner({
        sql,
        beacon,
        tasks,
        bots,
        tank,
        gh,
        executors,
        tiers,
        config,
        control,
        memory,
        tokens,
        indexer,
        ranker,
        approvals,
        notes,
      })
      const { abandon } = runner
      // A settled child reports its verdict to its parent's stream (T-046), after every run, whoever started it.
      const runAndReport = (id: TaskId) =>
        runner
          .runTask(id)
          .pipe(Effect.tap((result) => (result.recorded ? reportChild(id, result.verdict) : Effect.void)))
      // A task the planning flow settled reports to its parent like any other (reportChild is idempotent).
      const reporting = (run: ((id: TaskId) => Effect.Effect<RunResult>) | undefined) =>
        run === undefined
          ? undefined
          : (id: TaskId) =>
              run(id).pipe(
                Effect.tap((result) => (result.recorded ? reportChild(id, result.verdict) : Effect.void)),
              )
      const lead: LeadShape = {
        abandon,
        intake,
        handoff,
        get: (id) =>
          tasks.get(id).pipe(
            Effect.map(({ spec, state, verdict }) => ({
              spec,
              state,
              ...(verdict === undefined ? {} : { verdict }),
            })),
          ),
        runOnce: (id) => Effect.map(runAndReport(id), (result) => result.verdict),
        runTask: runAndReport,
        // Boot: tokens of runs the restart interrupted are ended before the worker takes new work (T-168).
        startWorker: (opts) =>
          tokens.revokeStale().pipe(
            Effect.catch((error) => Effect.logError(`could not revoke stale MCP tokens: ${error._tag}`)),
            Effect.andThen(
              makeWorker({
                sql,
                runTask: reporting(opts.runTask) ?? runAndReport,
                abandon,
                config,
              }).startWorker(opts),
            ),
          ),
      }
      return Context.make(Lead, lead).pipe(Context.add(Control, control))
    }),
  )

// Convenience for the composition root: the Lead with its own TaskStore.
export const LeadWithStore = (
  tiers: TierConfig,
  overrides?: Partial<LeadConfig>,
  options?: LeadOptions,
): Layer.Layer<
  Lead | Control,
  never,
  SqlClient | Beacon | BotRegistry | Tank | GhClient | ExecutorRegistry
> => Layer.provide(LeadLive(tiers, overrides, options), Layer.merge(TaskStoreLive, McpTokensLive))

export {
  ApprovalFlow,
  ApprovalFlowLive,
  type ApprovalFlowShape,
  makeApprovalFlow,
} from "./approval-flow.js"
export { approvalCard, startApprovalNotifier } from "./approval-notify.js"
export {
  type BotFactoryConfig,
  type BotFactoryDeps,
  type ConfirmOutcome,
  handleConfirmBot,
  isCreateBotRequest,
  PROPOSAL_TTL_MS,
  type ProposeOutcome,
  parseConfirmBot,
  proposeBot,
} from "./bot-factory.js"
export { type Chat, ChatFailure, makeChat } from "./chat.js"
export {
  FORGET_CANDIDATES,
  forgetCallbackData,
  forgetCommand,
  MEMORY_CANCEL_DATA,
  type MemoryButton,
  type MemoryCallback,
  type MemoryCommandInput,
  type MemoryPort,
  type MemoryReply,
  memoryCallback,
  parseMemoryCallback,
  rememberCommand,
} from "./commands/memory.js"
export { extractiveSummarizer, type Summarizer } from "./context/compact.js"
export { type SummaryCache, sqlSummaryCache } from "./context/compact-cache.js"
export { type ContextConfig, loadContextConfig } from "./context/config.js"
export { Tokenizer, TokenizerLive, type TokenizerShape, TokenizerTest } from "./context/tokenizer.js"
export {
  botTarget,
  Control,
  type ControlBotStatus,
  type ControlShape,
  type ControlStatus,
  GLOBAL,
  type ScopeTarget,
  type StopReport,
  type StopTarget,
  taskTarget,
} from "./control.js"
export {
  PLANNING_RESTART_REASON,
  RESTART_REASON,
  RESUME_REASON,
  type RecoveryReport,
} from "./control-recovery.js"
export {
  type BotFactoryOptions,
  Conversation,
  ConversationLive,
  type ConversationOptions,
  type ConversationShape,
} from "./conversation.js"
export { ESCALATION_MIN_CHARS, escalate, parseChoice } from "./escalation.js"
export {
  type HandoffOutcome,
  type HandoffTask,
  MAX_AGENT_MSGS_PER_TASK,
  makeHandoff,
  remainingBudget,
} from "./handoff.js"
export {
  CONSOLIDATE_QUEUE,
  type ConsolidateHookOptions,
  executorConsolidationModel,
  startConsolidateHook,
} from "./hooks/consolidate.js"
export { INDEX_QUEUE, type IndexHookOptions, indexRepoOf, startIndexHook } from "./hooks/index-repo.js"
export { TASKS_QUEUE } from "./intake.js"
export { Lead, type LeadShape } from "./lead.js"
export {
  type IssuedMcpToken,
  type IssueMcpToken,
  MAX_MCP_TOKEN_TTL_MS,
  MCP_TOKEN_PREFIX,
  type McpScope,
  McpTokenRejected,
  McpTokens,
  McpTokensLive,
  type McpTokensShape,
  makeMcpTokens,
} from "./mcp-tokens.js"
export { makeOutcomes, type Outcomes, outcomeFor } from "./outcomes.js"
export { type CheckInput, checkDraft, MAX_STEPS } from "./plan/check.js"
export {
  DEFAULT_PLAN_CONCURRENCY,
  type Dispatcher,
  type DispatcherDeps,
  makeDispatcher,
  type PlanRun,
  type StepOutcome,
  type StepResult,
} from "./plan/dispatcher.js"
export { executorsUsed, fullResult } from "./plan/executors-used.js"
export { IntegrationFailed, makeIntegration, planBranchOf } from "./plan/integration.js"
export {
  makePlanner,
  type Planner,
  type PlannerDeps,
  type PlanOutcome,
  type PlanSignals,
  shouldPlan,
} from "./plan/planner.js"
export { buildPlanPrompt } from "./plan/prompt.js"
export { PlanDraft, planJsonSchema } from "./plan/schema-json.js"
export {
  makeStepVerify,
  policyAllow,
  type StepVerifyDeps,
  type VerifyInput,
  type VerifyStep,
} from "./plan/step-verify.js"
export { Planning, PlanningLive, type PlanningOptions, type PlanningShape } from "./planning.js"
export { makePodNotes, PodNotes, PodNotesLive, type PodNotesShape } from "./pod-notes.js"
export { makePods, type Pods, type PodsDeps, type PodTopicPort } from "./pods.js"
export {
  type ApprovalResume,
  type Carry,
  MAX_ATTEMPTS,
  type RetryDecision,
  type RoundResult,
  resumeAfterRestart,
  resumeCarry,
  type Worktree,
} from "./retry.js"
export { type McpGrant, type McpServerConfig, makeRunSetup } from "./run-setup.js"
export { DEFAULT_LEAD_CONFIG, type LeadConfig, type RunResult } from "./runner.js"
export { TaskStore, TaskStoreLive } from "./tasks.js"
export { stepIdFor } from "./verdict.js"
export {
  decideReview,
  type Finding,
  fixPrompt,
  type ParsedReview,
  parseReview,
  type ReviewDecision,
} from "./verify/review.js"
export {
  type FinalOutcome,
  JUDGE_MIN_CONFIDENCE,
  type JudgeAnswer,
  type Verification,
} from "./verify/rules.js"
export { type JudgeFacts, makeVerifier, type Verifier, type VerifierDeps } from "./verify/verifier.js"
