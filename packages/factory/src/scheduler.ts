import { Beacon, type BeaconShape } from "@shoalwork/beacon"
import { BotRegistry, type BotRegistryShape } from "@shoalwork/bots"
import { type Event, EventPayloads } from "@shoalwork/contracts"
import { GhClient, type GhClientShape } from "@shoalwork/currents"
import { Lead, type LeadShape } from "@shoalwork/lead"
import { Approvals, type ApprovalsShape, Policy, type PolicyShape } from "@shoalwork/policy"
import {
  Clock,
  Context,
  Effect,
  Layer,
  Option,
  Ref,
  Schedule,
  Schema,
  type Scope,
  Semaphore,
  Stream,
} from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import { makeCycle } from "./cycle.js"
import { cycleOfLeadTask } from "./cycle-rows.js"
import { DEFAULT_GATE, type GateConfig, gate } from "./cycle-text.js"
import { Kanban, type KanbanShape, projectBySlug, tasksOf } from "./kanban.js"
import { projectView } from "./kanban-rows.js"
import { isolate, readCi } from "./scheduler-support.js"
import { makeSweepProject } from "./scheduler-sweep.js"
import { repoOf } from "./sync-github.js"

// FactoryScheduler (T-061): for every active project it keeps the board and the delivery cycle moving. A periodic
// loop (30 s) does the work; events from GitHub and from finished Lead tasks wake the same pass sooner. The pass is
// idempotent, so a missed event costs at most one period.
export interface SchedulerDeps {
  readonly sql: SqlClient
  readonly beacon: BeaconShape
  readonly kanban: KanbanShape
  readonly lead: Pick<LeadShape, "intake" | "handoff" | "get">
  readonly bots: Pick<BotRegistryShape, "getByName">
  readonly gh: GhClientShape
  readonly policy?: Pick<PolicyShape, "evaluate"> | undefined
  readonly approvals?: Pick<ApprovalsShape, "request" | "get" | "consume"> | undefined
  readonly gate?: GateConfig
}

export interface FactorySchedulerShape {
  // One pass over one project: GitHub events into the board, CI results into the cycles, every task one step.
  readonly reconcile: (project: string) => Effect.Effect<void, unknown>
  // One pass over every active project; a failing project does not stop the others.
  readonly tick: Effect.Effect<number>
  // The observer's net (T-030): a PR with no CI event for too long is polled; an `in_review` task with no PR goes back.
  readonly sweep: Effect.Effect<number>
  readonly start: (options: { readonly pollMs: number }) => Effect.Effect<void, never, Scope.Scope>
  // Wakes the pass for the project an event belongs to, within the gate. True when it ran.
  readonly onEvent: (event: Event) => Effect.Effect<boolean>
}

export class FactoryScheduler extends Context.Service<FactoryScheduler, FactorySchedulerShape>()(
  "@shoalwork/FactoryScheduler",
) {}

const WAKING: ReadonlyArray<Event["type"]> = [
  "github.issues",
  "github.pull_request",
  "github.workflow_run",
  "task.state_changed",
]

const decodeTaskChange = Schema.decodeUnknownOption(EventPayloads["task.state_changed"])
const decodeRepo = Schema.decodeUnknownOption(Schema.Struct({ repo: Schema.String }))

export const makeScheduler = (deps: SchedulerDeps): FactorySchedulerShape => {
  const { sql, beacon, kanban } = deps
  const cycle = makeCycle(deps)
  const gateConfig = deps.gate ?? DEFAULT_GATE
  // One pass per scheduler at a time: a tick and an event on the same project never interleave.
  const lock = Semaphore.makeUnsafe(1)
  const gateState = Ref.makeUnsafe<ReadonlyMap<string, ReadonlyArray<number>>>(new Map())

  const activeProjects = Effect.gen(function* () {
    return (yield* kanban.listProjects()).filter((project) => project.status === "active")
  })

  const reconcile = (slug: string): Effect.Effect<void, unknown> =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const found = yield* projectBySlug(sql, slug)
        if (found === undefined || found.status !== "active") return
        const project = projectView(found)
        // Each step is isolated: a task or a step that breaks is logged and the rest of the pass still runs.
        yield* kanban.sync(slug).pipe(isolate(`${slug}/sync`))
        yield* readCi(sql, beacon, slug, repoOf(project.repoUrl)).pipe(isolate(`${slug}/ci`))
        for (const task of yield* tasksOf(sql, slug)) {
          yield* cycle.advance(project, task).pipe(isolate(`${slug}/${task.id}`))
        }
        yield* cycle.promote(project).pipe(isolate(`${slug}/promote`))
      }),
    )

  const logFailure = (slug: string) => (cause: unknown) =>
    Effect.logError(`factory pass failed for ${slug}`, cause)

  const tick = Effect.gen(function* () {
    let ran = 0
    for (const project of yield* activeProjects) {
      const ok = yield* reconcile(project.slug).pipe(
        Effect.as(true),
        Effect.catchCause((cause) => logFailure(project.slug)(cause).pipe(Effect.as(false))),
      )
      if (ok) ran += 1
    }
    return ran
  }).pipe(Effect.catchCause((cause) => Effect.logError("factory tick failed", cause).pipe(Effect.as(0))))

  const sweepProject = makeSweepProject(sql, beacon, cycle)

  const sweep = Effect.gen(function* () {
    let total = 0
    for (const project of yield* activeProjects) {
      total += yield* lock
        .withPermits(1)(sweepProject(project.slug))
        .pipe(Effect.catchCause((cause) => logFailure(project.slug)(cause).pipe(Effect.as(0))))
    }
    return total
  }).pipe(Effect.catchCause((cause) => Effect.logError("factory sweep failed", cause).pipe(Effect.as(0))))

  // The projects an event belongs to: by repository for GitHub, by the cycle that waits for a finished Lead task.
  const projectsOf = (event: Event): Effect.Effect<ReadonlyArray<string>, SqlError> =>
    Effect.gen(function* () {
      if (event.type === "task.state_changed") {
        const change = decodeTaskChange(event.payload)
        if (Option.isNone(change) || !["done", "failed", "cancelled"].includes(change.value.to)) return []
        const row = yield* cycleOfLeadTask(sql, change.value.taskId)
        return row === undefined ? [] : [row.project]
      }
      const repo = decodeRepo(event.payload)
      if (Option.isNone(repo)) return []
      const wanted = repo.value.repo.toLowerCase()
      return (yield* activeProjects)
        .filter((project) => repoOf(project.repoUrl) === wanted)
        .map((project) => project.slug)
    })

  const onEvent = (event: Event): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      // The factory's own writes never wake it: the loop is fed only by GitHub and by finished Lead tasks.
      if (event.actor.startsWith("system:factory") || !WAKING.includes(event.type)) return false
      const slugs = yield* projectsOf(event)
      const now = yield* Clock.currentTimeMillis
      let ran = false
      for (const slug of slugs) {
        const verdict = gate((yield* Ref.get(gateState)).get(slug) ?? [], now, gateConfig)
        yield* Ref.update(gateState, (state) => new Map(state).set(slug, verdict.runs))
        if (!verdict.allow) continue
        yield* reconcile(slug).pipe(Effect.catchCause(logFailure(slug)))
        ran = true
      }
      return ran
    }).pipe(
      Effect.catchCause((cause) => Effect.logError("factory event failed", cause).pipe(Effect.as(false))),
    )

  const start: FactorySchedulerShape["start"] = (options) =>
    Effect.gen(function* () {
      const feed = yield* beacon.subscribe([...WAKING])
      yield* Effect.forkScoped(Stream.runForEach(feed, (event) => onEvent(event).pipe(Effect.asVoid)))
      yield* Effect.forkScoped(
        Effect.repeat(tick, Schedule.spaced(`${options.pollMs} millis`)).pipe(Effect.asVoid),
      )
    })

  return { reconcile, tick, sweep, start, onEvent }
}

// Policy and Approvals are optional: without them a merge is refused (fail-closed).
export const FactorySchedulerLive: Layer.Layer<
  FactoryScheduler,
  never,
  SqlClient | Beacon | Kanban | Lead | GhClient | BotRegistry
> = Layer.effect(
  FactoryScheduler,
  Effect.gen(function* () {
    return makeScheduler({
      sql: yield* SqlClient,
      beacon: yield* Beacon,
      kanban: yield* Kanban,
      lead: yield* Lead,
      bots: yield* BotRegistry,
      gh: yield* GhClient,
      policy: Option.getOrUndefined(yield* Effect.serviceOption(Policy)),
      approvals: Option.getOrUndefined(yield* Effect.serviceOption(Approvals)),
    })
  }),
)
