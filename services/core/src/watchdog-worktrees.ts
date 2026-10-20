import { Beacon } from "@shoalwork/beacon"
import { BotRegistry } from "@shoalwork/bots"
import type { Bot, TaskId } from "@shoalwork/contracts"
import { stepIdFor } from "@shoalwork/lead"
import { Tank } from "@shoalwork/tank"
import { Clock, Effect, Option, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { decodeRows, guarded, recovered, TaskRow } from "./watchdog-support.js"

const WORKTREE_TTL_MS = 24 * 60 * 60 * 1000
const RepoSpec = Schema.Struct({ repo: Schema.optional(Schema.Struct({ url: Schema.String })) })

export interface WorktreeGroup {
  readonly bot: Bot
  readonly repoUrl: string
  // Branch of every step a task may have used (one per attempt) -> the task.
  readonly branches: Map<string, TaskId>
}

// Worktrees of terminal tasks older than a day are removed (T-031 debt). Running tasks are never touched.
export const sweepOrphanWorktrees = () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const beacon = yield* Beacon
    const bots = yield* BotRegistry
    const tank = yield* Tank
    const now = yield* Clock.currentTimeMillis
    const cutoff = new Date(now - WORKTREE_TTL_MS).toISOString()
    const rows = yield* sql`SELECT id, bot_id, attempts, state, spec, updated_at FROM tasks
      WHERE state IN ('done', 'failed', 'cancelled') AND updated_at < ${cutoff}`
    const groups = new Map<string, WorktreeGroup>()
    for (const row of yield* decodeRows(TaskRow, rows)) {
      const repo = yield* Effect.try({
        try: (): unknown => JSON.parse(row.spec),
        catch: (cause) => cause,
      }).pipe(
        Effect.flatMap((raw) => Schema.decodeUnknownEffect(RepoSpec)(raw)),
        Effect.option,
        Effect.map((parsed) => (Option.isSome(parsed) ? parsed.value.repo : undefined)),
      )
      if (repo === undefined) continue
      const bot = yield* bots.get(row.bot_id).pipe(Effect.option)
      if (Option.isNone(bot)) continue
      const key = `${row.bot_id}\n${repo.url}`
      const group = groups.get(key) ?? {
        bot: bot.value,
        repoUrl: repo.url,
        branches: new Map<string, TaskId>(),
      }
      for (let attempt = 1; attempt <= row.attempts + 1; attempt++) {
        group.branches.set(`bot/${bot.value.name}/${stepIdFor(row.id, attempt)}`, row.id)
      }
      groups.set(key, group)
    }
    let count = 0
    for (const group of groups.values()) {
      const removed = yield* guarded(
        "orphan_worktrees",
        Effect.gen(function* () {
          let done = 0
          for (const wt of yield* tank.worktrees(group.bot, group.repoUrl)) {
            if (!group.branches.has(wt.branch)) continue
            done += yield* guarded(
              "orphan_worktrees",
              tank
                .removeWorktree(group.bot, wt)
                .pipe(
                  Effect.andThen(recovered(beacon, "orphan_worktree", wt.branch, "removed")),
                  Effect.as(1),
                ),
            )
          }
          return done
        }),
      )
      count += removed
    }
    return count
  })
