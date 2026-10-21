import type { BeaconShape } from "@shoalwork/beacon"
import {
  type Event,
  EventPayloads,
  type ReplayOverrides,
  streamIds,
  type TaskId,
  type TaskState,
  type Verdict,
} from "@shoalwork/contracts"
import { Effect, Option, Schema, Stream } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import { DELIVERY_SKIPPED } from "./deliver.js"

// What one run left in the log, as the Farol compares it. Everything here is read from events, which are data and not
// instructions (R14): strings are clipped and counted, never interpreted.
export interface RunSummary {
  readonly taskId: TaskId
  readonly state: TaskState
  // Null while the task has no verdict yet.
  readonly verdict: Verdict | null
  readonly usage: {
    readonly tokensIn: number
    readonly tokensOut: number
    readonly usd: number
    readonly seconds: number
  }
  readonly durationMs: number
  readonly executor: string | null
  readonly model: string | null
  readonly files: ReadonlyArray<string>
  readonly evidence: ReadonlyArray<string>
}

export interface ReplayDiff {
  readonly verdictChanged: boolean
  readonly usdDelta: number
  readonly durationDeltaMs: number
  readonly executorChanged: boolean
  readonly modelChanged: boolean
  readonly filesOnlyInSource: ReadonlyArray<string>
  readonly filesOnlyInReplay: ReadonlyArray<string>
  readonly evidenceOnlyInSource: ReadonlyArray<string>
  readonly evidenceOnlyInReplay: ReadonlyArray<string>
}

export interface ReplayComparison {
  readonly id: string
  readonly sourceTaskId: TaskId
  readonly newTaskId: TaskId
  readonly overrides: ReplayOverrides
  readonly baseSha: string | null
  readonly contextFrozen: boolean
  readonly createdAt: string
  readonly source: RunSummary
  readonly replay: RunSummary
  readonly diff: ReplayDiff
  // Things a reader should know about the replay run (e.g. its base commit was not available).
  readonly notes: ReadonlyArray<string>
}

const FILES_MAX = 500
const PATH_MAX = 500
const decodeStarted = Schema.decodeUnknownOption(EventPayloads["executor.started"])
const decodeFinished = Schema.decodeUnknownOption(EventPayloads["executor.finished"])
const decodeUsage = Schema.decodeUnknownOption(EventPayloads["usage.recorded"])
const decodeExecutorEvent = Schema.decodeUnknownOption(EventPayloads["executor.event"])
const decodeError = Schema.decodeUnknownOption(EventPayloads["error.raised"])

export const readTaskEvents = (
  beacon: BeaconShape,
  taskId: TaskId,
): Effect.Effect<ReadonlyArray<Event>, SqlError> =>
  Stream.runCollect(beacon.readStream(streamIds.task(taskId), 0)).pipe(
    Effect.map((chunk) => Array.from(chunk)),
  )

// The first base commit a task's run recorded (a retry that reuses the worktree starts further along).
export const baseShaOf = (events: ReadonlyArray<Event>): string | undefined => {
  for (const event of events) {
    if (event.type !== "executor.started") continue
    const started = decodeStarted(event.payload)
    if (Option.isSome(started) && started.value.baseSha !== undefined) return started.value.baseSha
  }
  return undefined
}

// The executor of the last run a task recorded.
export const executorOf = (events: ReadonlyArray<Event>): string | undefined => {
  let executor: string | undefined
  for (const event of events) {
    if (event.type !== "executor.started") continue
    const started = decodeStarted(event.payload)
    if (Option.isSome(started)) executor = started.value.executor
  }
  return executor
}

// Artifact refs (a PR, a pushed branch) and the delivery marker are not evidence of the work: they stay out of the diff.
const ARTIFACT_REF = /^(https?:\/\/|bot\/)/
export const isArtifactRef = (line: string): boolean => ARTIFACT_REF.test(line) || line === DELIVERY_SKIPPED

export const summarize = (
  events: ReadonlyArray<Event>,
  task: { readonly taskId: TaskId; readonly state: TaskState; readonly verdict: Verdict | undefined },
): RunSummary => {
  let executor: string | null = null
  let model: string | null = null
  let durationMs = 0
  let usage = { tokensIn: 0, tokensOut: 0, usd: 0, seconds: 0 }
  const files = new Set<string>()
  for (const event of events) {
    switch (event.type) {
      case "executor.started": {
        const started = decodeStarted(event.payload)
        if (Option.isSome(started)) {
          executor = started.value.executor
          model = started.value.model
        }
        break
      }
      case "executor.finished": {
        const finished = decodeFinished(event.payload)
        if (Option.isSome(finished)) durationMs += finished.value.durationMs
        break
      }
      case "usage.recorded": {
        const recorded = decodeUsage(event.payload)
        if (Option.isSome(recorded)) {
          const u = recorded.value.usage
          usage = {
            tokensIn: usage.tokensIn + u.tokensIn,
            tokensOut: usage.tokensOut + u.tokensOut,
            usd: usage.usd + u.usd,
            seconds: usage.seconds + u.seconds,
          }
        }
        break
      }
      case "executor.event": {
        const decoded = decodeExecutorEvent(event.payload)
        if (Option.isSome(decoded) && decoded.value.event.kind === "file_edit" && files.size < FILES_MAX) {
          files.add(decoded.value.event.path.slice(0, PATH_MAX))
        }
        break
      }
      default:
        break
    }
  }
  return {
    taskId: task.taskId,
    state: task.state,
    verdict: task.verdict ?? null,
    usage,
    durationMs,
    executor,
    model,
    files: [...files],
    evidence: (task.verdict?.evidence ?? []).filter((line) => !isArtifactRef(line)),
  }
}

const onlyIn = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): ReadonlyArray<string> => {
  const other = new Set(right)
  return left.filter((item) => !other.has(item))
}

// Both runs side by side. A verdict "changed" only when both runs have one and the kinds differ.
export const diffOf = (source: RunSummary, replay: RunSummary): ReplayDiff => ({
  verdictChanged:
    source.verdict !== null && replay.verdict !== null && source.verdict.kind !== replay.verdict.kind,
  usdDelta: replay.usage.usd - source.usage.usd,
  durationDeltaMs: replay.durationMs - source.durationMs,
  executorChanged: source.executor !== replay.executor,
  modelChanged: source.model !== replay.model,
  filesOnlyInSource: onlyIn(source.files, replay.files),
  filesOnlyInReplay: onlyIn(replay.files, source.files),
  evidenceOnlyInSource: onlyIn(source.evidence, replay.evidence),
  evidenceOnlyInReplay: onlyIn(replay.evidence, source.evidence),
})

// What a reader should know about the replay run: it started from another base, or it delivered nothing by design.
export const notesOf = (
  events: ReadonlyArray<Event>,
  verdict: Verdict | undefined,
): ReadonlyArray<string> => [
  ...(verdict?.evidence.includes(DELIVERY_SKIPPED) === true
    ? ["Delivery skipped: a replay pushes no branch and opens no PR."]
    : []),
  ...baseNotes(events),
]

const baseNotes = (events: ReadonlyArray<Event>): ReadonlyArray<string> =>
  events.flatMap((event) => {
    if (event.type !== "error.raised") return []
    const raised = decodeError(event.payload)
    return Option.isSome(raised) && raised.value.where === "lead.replay.base"
      ? ["The recorded base commit was not available: the replay did not run."]
      : []
  })
