import type { BotRegistryShape } from "@shoalwork/bots"
import { ZERO_USAGE } from "@shoalwork/contracts"
import type { TankShape } from "@shoalwork/tank"
import { Effect } from "effect"
import type { Carry } from "./retry.js"
import type { TaskRecord } from "./tasks.js"
import { stepIdFor } from "./verdict.js"

// A task found `running` when its job is delivered was interrupted by a restart (the boot recovery put the job back
// in the queue). It continues as a retry of the run it lost: same step, so the worktree and branch of that run, with
// the fallback flag so the attempt is not counted again. Returns undefined when it cannot continue (no worktree to
// reuse, or the Tank refuses it): the task then starts a fresh run.
export const recoveredCarry = (
  deps: { readonly tank: TankShape; readonly bots: BotRegistryShape },
  record: TaskRecord,
): Effect.Effect<Carry | undefined> =>
  Effect.gen(function* () {
    if (record.state !== "running" || record.attempts < 1) {
      return undefined
    }
    const { spec } = record
    const stepId = stepIdFor(spec.id, record.attempts)
    const base: Carry = {
      stepId,
      worktree: undefined,
      sessionId: record.sessionId,
      tail: "",
      usage: ZERO_USAGE,
      fallback: true,
    }
    if (spec.repo === undefined) {
      return base
    }
    const repo = spec.repo
    const bot = yield* deps.bots.get(spec.botId)
    const owned = yield* deps.tank.worktrees(bot, repo.url)
    const found = owned.find((worktree) => worktree.branch === `bot/${bot.name}/${stepId}`)
    if (found === undefined) {
      return undefined
    }
    const reuse = { path: found.path, branch: found.branch }
    // Proves the Tank accepts the reuse before the run depends on it; the worktree is kept either way.
    yield* deps.tank
      .prepare(bot, { stepId, repo, reuse })
      .pipe(Effect.flatMap((ctx) => deps.tank.release(ctx, { keepWorktree: true })))
    return { ...base, worktree: reuse }
  }).pipe(Effect.orElseSucceed((): Carry | undefined => undefined))
