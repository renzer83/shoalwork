import type { Bot, BotId, RepoRef, StepId, TankError, TankMode, WorktreeConflict } from "@shoalwork/contracts"
import { Context, type Effect, type Scope, type Stream } from "effect"

export type TankContext = {
  readonly botId: BotId
  readonly botName: string
  readonly cwd: string
  readonly home: string
  readonly env: Readonly<Record<string, string>>
  readonly worktree?: { readonly path: string; readonly branch: string; readonly repoDir: string }
}

export type ExecResult = {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
  readonly timedOut: boolean
}

export type ExecOptions = { readonly timeoutMs?: number; readonly stdin?: string }

export type RunningProcess = {
  readonly pid: number
  readonly stdout: Stream.Stream<string, TankError>
  readonly stderr: Stream.Stream<string, TankError>
  readonly exitCode: Effect.Effect<number>
  readonly writeStdin: (s: string) => Effect.Effect<void>
  readonly closeStdin: () => Effect.Effect<void>
  readonly kill: (signal?: "SIGTERM" | "SIGKILL") => Effect.Effect<void>
}

export interface TankShape {
  readonly mode: TankMode
  // reuse: continue the worktree an earlier attempt of the same step kept (must still be registered for the Bot);
  // without it, a worktree that already exists is a WorktreeConflict.
  readonly prepare: (
    bot: Bot,
    step: {
      readonly stepId: StepId
      readonly repo?: RepoRef
      readonly reuse?: { readonly path: string; readonly branch: string }
    },
  ) => Effect.Effect<TankContext, TankError | WorktreeConflict>
  readonly exec: (
    ctx: TankContext,
    cmd: ReadonlyArray<string>,
    opts?: ExecOptions,
  ) => Effect.Effect<ExecResult, TankError>
  readonly spawnStream: (
    ctx: TankContext,
    cmd: ReadonlyArray<string>,
  ) => Effect.Effect<RunningProcess, TankError, Scope.Scope>
  readonly readFile: (ctx: TankContext, rel: string) => Effect.Effect<string, TankError>
  readonly writeFile: (ctx: TankContext, rel: string, content: string) => Effect.Effect<void, TankError>
  readonly release: (
    ctx: TankContext,
    opts: { readonly keepWorktree: boolean },
  ) => Effect.Effect<void, TankError>
}

export class Tank extends Context.Service<Tank, TankShape>()("@shoalwork/Tank") {}
