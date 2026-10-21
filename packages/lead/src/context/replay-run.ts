import type { TaskSpec } from "@shoalwork/contracts"
import type { TankContext, TankShape } from "@shoalwork/tank"
import { Cause, Effect, Option } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { redactSecrets } from "../narrator.js"
import {
  loadSnapshot,
  type ReplayLink,
  ReplayUnavailable,
  replayOfRun,
  saveSnapshot,
} from "../replay-store.js"
import type { Briefing } from "./briefing.js"
import type { ContextLevel } from "./planner.js"

// What a replay (T-122) carries into the run: the link row of this task, and the context text of its source when the
// replay froze it. Read once per run by the runner and handed to every step that needs it.
export interface ReplayRun {
  readonly link: ReplayLink
  readonly frozen: Briefing | undefined
}

const LEVELS: ReadonlyArray<ContextLevel> = ["none", "top3", "full"]

const levelOf = (raw: string): ContextLevel => LEVELS.find((level) => level === raw) ?? "full"

// A read that fails is not the run's failure; an interruption still is.
const soft = <A>(effect: Effect.Effect<A, unknown>, otherwise: A): Effect.Effect<A> =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.succeed(otherwise),
    ),
  )

// Undefined for an ordinary task (no SqlClient in scope, or no replay row). A replay row that cannot be read, or whose
// frozen context is gone, fails the run with ReplayUnavailable: it must not run as an ordinary task.
export const replayRunOf = (
  spec: Pick<TaskSpec, "id">,
): Effect.Effect<ReplayRun | undefined, ReplayUnavailable> =>
  Effect.gen(function* () {
    const link = yield* replayOfRun(spec.id)
    if (link === undefined) return undefined
    if (!link.contextFrozen) return { link, frozen: undefined }
    const sql = Option.getOrUndefined(yield* Effect.serviceOption(SqlClient))
    const snapshot =
      sql === undefined
        ? undefined
        : yield* loadSnapshot(sql, link.sourceTaskId).pipe(
            Effect.catchTag("SqlError", () => Effect.succeed(undefined)),
          )
    if (snapshot === undefined) {
      return yield* Effect.fail(
        new ReplayUnavailable({ reason: "the context of the source is not available" }),
      )
    }
    // The same text, with the counts the source run recorded: the briefing is not rebuilt and nothing is dropped again.
    const frozen: Briefing = {
      text: snapshot.text,
      level: levelOf(snapshot.level),
      used: snapshot.used,
      budget: snapshot.budget,
      dropped: [],
      tokenSource: "approx",
      compaction: [],
    }
    return { link, frozen }
  })

// Keeps the text of the context a run was given, for a later replay: secrets redacted, first attempt only (the table
// ignores a second insert). It is derived data, so a failure to keep it never fails the run.
export const keepSnapshot = (spec: Pick<TaskSpec, "id">, briefing: Briefing): Effect.Effect<void> =>
  Effect.gen(function* () {
    const sql = Option.getOrUndefined(yield* Effect.serviceOption(SqlClient))
    if (sql === undefined) return
    yield* soft(
      saveSnapshot(sql, spec.id, {
        text: redactSecrets(briefing.text),
        level: briefing.level,
        used: briefing.used,
        budget: briefing.budget,
      }),
      undefined,
    )
  })

type AlignResult = { readonly _tag: "Aligned" } | { readonly _tag: "Unavailable"; readonly reason: string }

// Puts a fresh worktree on the commit the source run started from (the base sha was validated as hex when the replay
// was stored, so it cannot pass as an option). The worktree was cut from the branch tip; the commit must still exist in
// the clone, or the replay would run on a different base without saying so.
const alignToBase = (tank: TankShape, ctx: TankContext, sha: string): Effect.Effect<AlignResult> =>
  Effect.gen(function* () {
    const found = yield* tank.exec(ctx, ["git", "cat-file", "-e", `${sha}^{commit}`], { timeoutMs: 15_000 })
    if (found.exitCode !== 0) return { _tag: "Unavailable", reason: "commit not in the clone" } as const
    const reset = yield* tank.exec(ctx, ["git", "reset", "--hard", "--quiet", sha], { timeoutMs: 30_000 })
    return reset.exitCode === 0
      ? ({ _tag: "Aligned" } as const)
      : ({ _tag: "Unavailable", reason: "reset failed" } as const)
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.succeed({ _tag: "Unavailable", reason: "git failed" } as const),
    ),
  )

export interface AlignDeps {
  readonly tank: TankShape
  readonly raiseError: (
    spec: Pick<TaskSpec, "id" | "botId">,
    where: string,
    tag: string,
    message: string,
  ) => Effect.Effect<void>
}

// The first step of a replay's run, BEFORE executor.started is recorded (so its baseSha is the commit the run really
// starts from). Only a fresh worktree is moved: a retry continues the work already on its own. A base that cannot be
// applied is reported (error.raised, read by the comparison) and fails the run.
export const alignReplayBase = (
  deps: AlignDeps,
  spec: Pick<TaskSpec, "id" | "botId">,
  ctx: TankContext,
  replay: ReplayRun | undefined,
  fresh: boolean,
): Effect.Effect<void, ReplayUnavailable> =>
  Effect.gen(function* () {
    const sha = replay?.link.baseSha
    if (sha === undefined || ctx.worktree === undefined || !fresh) return
    const aligned = yield* alignToBase(deps.tank, ctx, sha)
    if (aligned._tag === "Unavailable") {
      yield* deps.raiseError(spec, "lead.replay.base", "BaseUnavailable", `replay base: ${aligned.reason}`)
      return yield* Effect.fail(new ReplayUnavailable({ reason: `base commit: ${aligned.reason}` }))
    }
  })
