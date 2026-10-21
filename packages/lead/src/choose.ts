import { Beacon, type ExecutorQualityRow, readExecutorQualityRows } from "@shoalwork/beacon"
import {
  type Bot,
  type Effort,
  type ExecutorId,
  type ModelTier,
  type NotFound,
  newEventId,
  streamIds,
  type TaskKind,
} from "@shoalwork/contracts"
import {
  type Executor,
  type ExecutorRegistry,
  type RankedExecutor,
  rankTier,
  resolveTier,
  type TierConfig,
} from "@shoalwork/executors"
import { Effect, Option } from "effect"
import { SqlClient } from "effect/sql/SqlClient"

// What a task runs with: the executor, and the model and effort the tier table (or the Bot override) resolved.
// `reasons` is set only for a ranked choice (ChooseRoute): the reasons of the chosen executor's score.
export interface Chosen {
  readonly executor: Executor
  readonly model: string
  readonly effort?: Effort
  readonly reasons?: ReadonlyArray<string>
}

// A ranked choice (T-074): the candidates are scored on their history for `kind` (executor_quality), their quota and
// their cost. The choice is recorded as decision.made (questionId "executor", source "rule") with its reasons, under
// `correlationId` (the task's). Without a route the table decides alone, as before.
export interface ChooseRoute {
  readonly kind: TaskKind
  readonly correlationId: string
}

// Quality rows for the ranking; no SqlClient in scope (a bare test core) means no history, and a failed read is logged.
const qualityRows = (): Effect.Effect<ReadonlyArray<ExecutorQualityRow>> =>
  Effect.gen(function* () {
    const sql = Option.getOrUndefined(yield* Effect.serviceOption(SqlClient))
    if (sql === undefined) return []
    return yield* readExecutorQualityRows(sql).pipe(
      Effect.catch((error) =>
        Effect.logWarning("executor quality not read", error).pipe(
          Effect.map((): ReadonlyArray<ExecutorQualityRow> => []),
        ),
      ),
    )
  })

// Appends the choice as a decision.made. A failure is logged: a task never fails because its decision was not written.
const recordChoice = (
  route: ChooseRoute,
  tier: ModelTier,
  executor: ExecutorId,
  reasons: ReadonlyArray<string>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const beacon = Option.getOrUndefined(yield* Effect.serviceOption(Beacon))
    if (beacon === undefined) return
    yield* beacon
      .append({
        streamId: streamIds.system,
        type: "decision.made",
        payload: {
          decisionId: newEventId(),
          questionId: "executor",
          kind: "choice",
          value: executor,
          confidence: 1,
          source: "rule",
          facts: { kind: route.kind, tier, reasons: [...reasons] },
        },
        actor: "system:lead",
        correlationId: route.correlationId,
      })
      .pipe(
        Effect.catch((error) => Effect.logWarning("executor decision not recorded", error)),
        Effect.asVoid,
      )
  })

// The executor that serves a task's tier, via resolveTier: the Bot's override for the tier, then the global table, then
// the first available alternative. Two policies apply first:
//   - bot.executors.allowed is policy: an executor outside it counts as unavailable (primary or alternative).
//   - bot.executors.preferred does not decide; the tier does.
// `exclude` (a reviewer's task): executors that may never serve it, whatever the table or an override says.
// `route` (optional): the candidates are ranked (rankExecutors) and the choice is recorded as decision.made.
// None when no candidate is allowed, registered and available; the runner then records a blocked verdict.
export const chooseExecutor = (
  tiers: TierConfig,
  bot: Pick<Bot, "executors" | "modelTiers">,
  tier: ModelTier,
  registry: typeof ExecutorRegistry.Service,
  exclude: ReadonlyArray<ExecutorId> = [],
  route?: ChooseRoute,
): Effect.Effect<Option.Option<Chosen>, NotFound> =>
  Effect.gen(function* () {
    const allowed = registry.list().filter((id) => bot.executors.allowed.includes(id))
    const executors = yield* Effect.forEach(allowed, (id) => registry.get(id))
    const ranking = route === undefined ? undefined : { kind: route.kind, quality: yield* qualityRows() }
    const resolved = yield* resolveTier(tiers, bot.modelTiers, tier, executors, {
      exclude,
      ...(ranking === undefined ? {} : { route: ranking }),
    }).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (resolved === undefined) {
      return Option.none()
    }
    const executor = executors.find((candidate) => candidate.id === resolved.executor)
    if (executor === undefined) {
      return Option.none()
    }
    if (route !== undefined) {
      yield* recordChoice(route, tier, resolved.executor, resolved.reasons ?? [])
    }
    return Option.some({
      executor,
      model: resolved.model,
      ...(resolved.effort === undefined ? {} : { effort: resolved.effort }),
      ...(resolved.reasons === undefined ? {} : { reasons: resolved.reasons }),
    })
  })

// The ranking of a Bot's executors for one tier and kind, for the Reflex's executor question. Only what the Bot may use
// is ranked: an executor outside bot.executors.allowed is excluded, and the Bot's own modelTiers override applies.
export const rankForBot = (
  tiers: TierConfig,
  bot: Pick<Bot, "executors" | "modelTiers">,
  tier: ModelTier,
  kind: TaskKind,
  registry: typeof ExecutorRegistry.Service,
  quality: ReadonlyArray<ExecutorQualityRow>,
): Effect.Effect<ReadonlyArray<RankedExecutor>, NotFound> =>
  Effect.gen(function* () {
    const ids = registry.list()
    const registered = yield* Effect.forEach(ids, (id) => registry.get(id))
    const notAllowed = ids.filter((id) => !bot.executors.allowed.includes(id))
    return yield* rankTier(tiers, bot.modelTiers, tier, kind, registered, quality, notAllowed)
  })
