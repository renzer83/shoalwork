import type { BotRegistryShape } from "@shoalwork/bots"
import type { Bot, ExecutorId, StepId, TankError, TaskSpec, WorktreeConflict } from "@shoalwork/contracts"
import type { ExecutorContext, McpAttachment } from "@shoalwork/executors"
import { type IndexerShape, isIgnoredPath, looksLikeSecret, type RankerShape } from "@shoalwork/reef"
import type { TankContext, TankShape } from "@shoalwork/tank"
import { Effect, Exit, type Redacted, Ref } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import type { BotMcpShape } from "./bot-mcp.js"
import type { BriefingMemory } from "./context/briefing.js"
import type { ContextConfig } from "./context/config.js"
import type { InjectDeps } from "./context/inject.js"
import { makeInjectorFor } from "./context/injector-for.js"
import { PermissionBridgeUnavailable } from "./executor-task.js"
import type { McpTokensShape } from "./mcp-tokens.js"
import { makeWithMcp } from "./run-mcp.js"
import { clearProcesses } from "./run-processes.js"
import { describeFailure, type Progress } from "./verdict.js"

export { executorTaskFor, PermissionBridgeUnavailable, withBridgeMode } from "./executor-task.js"

// What the core attaches for the reef MCP server (T-168). Both come from config.ts.
export interface McpServerConfig {
  // Built entrypoint of the reef MCP server (bin app-reef-mcp). Absolute path.
  readonly serverEntry: string
  // Origin of the core API the server calls (http or https).
  readonly api: string
  // The permission bridge of a claude-code run (T-177). Absent: the run keeps its static permission mode.
  readonly permissionBridge?: {
    // Built entrypoint of the bridge server (packages/executors/dist/permission-bridge/index.js). Absolute path.
    readonly serverEntry: string
    readonly mode: "inline" | "resume"
  }
}

// One execution's MCP grant: the env that carries its token to the Tank, and the attachment the adapter writes down.
export interface McpGrant {
  readonly extraEnv: Readonly<Record<string, string>>
  readonly attachment: McpAttachment
  // Secrets of the Bot's own MCP servers (T-185), by env name; only the Tank unwraps them.
  readonly secretEnv?: Readonly<Record<string, Redacted.Redacted<string>>>
}

type RaiseError = (
  spec: Pick<TaskSpec, "id" | "botId">,
  where: string,
  tag: string,
  message: string,
) => Effect.Effect<void>

export interface RunSetupDeps {
  readonly sql: SqlClient
  readonly bots: BotRegistryShape
  readonly tank: TankShape
  readonly tokens: McpTokensShape
  readonly mcp: McpServerConfig | undefined
  // The Bot's own MCP servers and their secrets (T-185). Without it a run gets only the reef server.
  readonly botMcp?: BotMcpShape | undefined
  readonly memory: BriefingMemory | undefined
  readonly raiseError: RaiseError
  // The repo index for the briefing's code block (T-041). Without it the briefing carries no code.
  readonly indexer?: IndexerShape | undefined
  // Six-signal ranking of the index's candidates (T-096); needs the indexer.
  readonly ranker?: RankerShape | undefined
  // config/context.yaml, read once by the composition root.
  readonly context?: ContextConfig | undefined
  readonly recordAssembled?: InjectDeps["recordAssembled"]
}

export interface AcquireInput {
  readonly spec: TaskSpec
  readonly bot: Bot
  readonly executorId: ExecutorId
  readonly budgetLeftMs: number
  readonly stepId: StepId
  readonly reuse: { readonly path: string; readonly branch: string } | undefined
  readonly progress: Ref.Ref<Progress>
}

// Everything between the decision to run and the executor's first byte: the Tank context, the MCP token, the briefing,
// and the release of all of it. Problems here are reported and the run goes on without the part that failed (MCP,
// briefing); they never fail it.
export const makeRunSetup = (deps: RunSetupDeps) => {
  const inject = makeInjectorFor({
    tank: deps.tank,
    memory: deps.memory,
    indexer: deps.indexer,
    ranker: deps.ranker,
    context: deps.context,
    recordAssembled: deps.recordAssembled,
    raiseError: deps.raiseError,
  })
  const report = (spec: Pick<TaskSpec, "id" | "botId">, where: string, cause: unknown) => {
    const { tag, message } = describeFailure(cause)
    return deps.raiseError(spec, where, tag, message)
  }

  // Another task of the same Bot may already have set it. A paused Bot stays paused while its tasks run.
  const markWorking = (spec: TaskSpec) =>
    Effect.gen(function* () {
      const states = yield* deps.bots.list()
      const botState = states.find((b) => b.id === spec.botId)?.state
      if (botState !== "working" && botState !== "paused") {
        yield* deps.bots.setState(spec.botId, "working", spec.id)
      }
    })

  // Revoking is the last thing every execution does, on every path (ok, failure, stop, timeout, defect).
  const revokeTask = (spec: TaskSpec) =>
    deps.tokens.revoke(spec.id).pipe(Effect.catch((cause) => report(spec, "lead.mcp", cause)))
  const withMcp = makeWithMcp({ ...deps, report, revokeTask })

  // The Tank context of the execution. Only the step's own SHOALWORK_* keys reach the Tank (extraEnv).
  // A carried worktree is reused: a retry continues the step of the run before it.
  const prepare = (
    bot: Bot,
    spec: TaskSpec,
    stepId: StepId,
    reuse: { readonly path: string; readonly branch: string } | undefined,
    grant: McpGrant | undefined,
  ) =>
    deps.tank.prepare(bot, {
      stepId,
      ...(spec.repo === undefined ? {} : { repo: spec.repo }),
      ...(reuse === undefined ? {} : { reuse }),
      ...(grant === undefined ? {} : { extraEnv: grant.extraEnv }),
      ...(grant?.secretEnv === undefined ? {} : { secretEnv: grant.secretEnv }),
    })

  // The run's files (its `file` artifacts, paths relative to the worktree) are published at the end of every run, before
  // the worktree can go (T-172). A failure is reported like the other cleanup steps; the verdict does not change.
  const publish = (spec: TaskSpec, ctx: TankContext, progress: Ref.Ref<Progress>) =>
    Effect.gen(function* () {
      const publishRun = deps.tank.publishArtifacts
      if (publishRun === undefined) return
      const files = (yield* Ref.get(progress)).artifacts.flatMap((artifact) =>
        artifact.kind === "file" ? [artifact.ref] : [],
      )
      yield* publishRun({
        taskId: spec.id,
        producedBy: spec.botId,
        cwd: ctx.cwd,
        files,
        screen: { refusePath: isIgnoredPath, refuseContent: looksLikeSecret },
      }).pipe(Effect.catch((cause) => report(spec, "lead.artifacts", cause)))
    })

  // Keep the worktree for diagnosis unless the run ended in an ok verdict, or for the Lead's checks (holdWorktree).
  const release = (
    spec: TaskSpec,
    ctx: TankContext,
    exit: Exit.Exit<unknown, unknown>,
    progress: Ref.Ref<Progress>,
  ) =>
    Effect.gen(function* () {
      const ok = Exit.isSuccess(exit) && (yield* Ref.get(progress)).outcome._tag === "Done"
      yield* clearProcesses(deps.sql, spec.id)
      yield* publish(spec, ctx, progress)
      yield* deps.tank
        .release(ctx, { keepWorktree: !ok || spec.holdWorktree === true })
        .pipe(
          Effect.catch((error) =>
            deps.raiseError(spec, "tank.release", error._tag, describeFailure(error).message),
          ),
        )
    })

  // The context the executor runs in: the Tank context plus the MCP attachment, when there is one.
  const executorContext = (ctx: TankContext, grant: McpGrant | undefined): ExecutorContext =>
    grant === undefined ? ctx : { ...ctx, mcp: grant.attachment }

  // The worktree becomes a workspace root of the Policy for this run's bridge calls (T-177). When it cannot be bound
  // the roots stay empty and every write by absolute path is asked: fail-closed.
  const bindWorkspace = (spec: TaskSpec, ctx: TankContext, grant: McpGrant | undefined) =>
    grant?.attachment.permissionBridge === undefined
      ? Effect.void
      : deps.tokens
          .bindWorkspace(spec.id, ctx.cwd)
          .pipe(
            Effect.catch((cause) =>
              report(spec, "lead.mcp", cause).pipe(
                Effect.andThen(Effect.fail(new PermissionBridgeUnavailable({ step: "workspace" }))),
              ),
            ),
          )

  // One execution's whole bracket: MCP grant, Tank context, `use`, release of the context, then revoke of the token.
  // Like acquireUseRelease, but prepare stays interruptible so the time budget also covers it (interrupting it tears
  // down the Tank's process group); once a context exists, release always runs.
  const acquire = <A, E, R>(
    input: AcquireInput,
    use: (ctx: TankContext, context: ExecutorContext) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | TankError | WorktreeConflict | PermissionBridgeUnavailable, R> =>
    withMcp(input.spec, input.bot, input.executorId, input.budgetLeftMs, (grant) =>
      Effect.uninterruptibleMask((restore) =>
        restore(prepare(input.bot, input.spec, input.stepId, input.reuse, grant)).pipe(
          Effect.flatMap((ctx) =>
            restore(
              bindWorkspace(input.spec, ctx, grant).pipe(
                Effect.andThen(use(ctx, executorContext(ctx, grant))),
              ),
            ).pipe(Effect.onExit((exit) => release(input.spec, ctx, exit, input.progress))),
          ),
        ),
      ),
    )

  return { markWorking, acquire, executorContext, inject }
}
