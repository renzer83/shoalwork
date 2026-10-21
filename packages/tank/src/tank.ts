import type { Bot, BotId, RepoRef, StepId, TankError, TankMode, WorktreeConflict } from "@shoalwork/contracts"
import { Context, type Effect, type Scope, type Stream } from "effect"
import type { PublishedArtifacts, PublishRun } from "./artifacts.js"

export type TankContext = {
  readonly botId: BotId
  readonly botName: string
  readonly cwd: string
  readonly home: string
  readonly env: Readonly<Record<string, string>>
  // The execution's own keys (SHOALWORK_*, e.g. its MCP token), already in env. They never reach argv (T-167).
  readonly stepEnv?: Readonly<Record<string, string>>
  readonly worktree?: { readonly path: string; readonly branch: string; readonly repoDir: string }
}

export type ExecResult = {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
  readonly timedOut: boolean
  // Set when `maxOutputBytes` was reached: the output was cut there and the process group was killed.
  readonly outputTruncated?: boolean
}

export type ExecOptions = {
  readonly timeoutMs?: number
  readonly stdin?: string
  // Stops accumulating stdout+stderr at this many bytes and kills the process group (result.outputTruncated).
  // Without it the output is unbounded, as before.
  readonly maxOutputBytes?: number
  // Run under the lock of the Bot's clone that owns ctx.worktree (the one prepare/release/worktree-add take), so a
  // fetch or rebase never races with them. Ignored for a context without a worktree.
  readonly lockRepo?: boolean
}

export type RunningProcess = {
  readonly pid: number
  readonly stdout: Stream.Stream<string, TankError>
  readonly stderr: Stream.Stream<string, TankError>
  readonly exitCode: Effect.Effect<number>
  readonly writeStdin: (s: string) => Effect.Effect<void>
  readonly closeStdin: () => Effect.Effect<void>
  readonly kill: (signal?: "SIGTERM" | "SIGKILL") => Effect.Effect<void>
}

// A linked worktree of one of the Bot's repos (branch bot/<bot>/<step>), as git lists it.
export type OwnedWorktree = {
  readonly repoDir: string
  readonly path: string
  readonly branch: string
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
      // Env of this execution only (e.g. its MCP token). Applied after the Tank's extraEnv, before the Tank's own keys.
      readonly extraEnv?: Readonly<Record<string, string>>
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
  // Writes a file under the Bot's home (not its cwd), with the same confinement as writeFile; mode is octal (0..0o777).
  readonly writeHomeFile: (
    ctx: TankContext,
    rel: string,
    content: string,
    mode: number,
  ) => Effect.Effect<void, TankError>
  readonly release: (
    ctx: TankContext,
    opts: { readonly keepWorktree: boolean },
  ) => Effect.Effect<void, TankError>
  // Worktrees of the Bot's clone of repoUrl whose branch is the Bot's own (none when the clone does not exist).
  readonly worktrees: (bot: Bot, repoUrl: string) => Effect.Effect<ReadonlyArray<OwnedWorktree>, TankError>
  // Removes one of the Bot's worktrees with its branch; same confinement as release.
  readonly removeWorktree: (bot: Bot, worktree: OwnedWorktree) => Effect.Effect<void, TankError>
  // Copies a run's files into the task's artifacts directory of this Tank (T-046, T-172). The root and the group are
  // the Tank's own: local mode keeps them under TANK_ROOT, server mode under the Bot homes with the shared group.
  // Optional so that test doubles of the shape need not carry it; both real Tanks always provide it.
  readonly publishArtifacts?: (input: PublishRun) => Effect.Effect<PublishedArtifacts, TankError>
}

export class Tank extends Context.Service<Tank, TankShape>()("@shoalwork/Tank") {}
