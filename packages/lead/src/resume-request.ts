import { type TaskId, TaskId as TaskIdSchema } from "@shoalwork/contracts"
import { Option, Schema } from "effect"
import { isTerminal } from "./outcomes.js"
import type { TaskRecord } from "./tasks.js"

// "continua a task <id|título>" and "continue task <id|título>": a continuation request typed in a Bot's topic.
// The argument is data (R14): it is only compared with the Bot's own tasks, never run and never used as a pattern.
const RESUME = /^continu[ae]\s+(?:a\s+)?task\s+([\s\S]+)$/i
// A title is compared as text; this cap keeps a long message from being matched in full.
const TITLE_MAX = 120

export type ResumeRequest =
  | { readonly kind: "id"; readonly id: TaskId }
  | { readonly kind: "title"; readonly title: string }

const decodeTaskId = Schema.decodeUnknownOption(TaskIdSchema)

// Undefined when the text is not a continuation request (the message goes on as an ordinary one).
export const parseResumeRequest = (text: string): ResumeRequest | undefined => {
  const argument = (RESUME.exec(text.trim())?.[1] ?? "").trim()
  if (argument === "") {
    return undefined
  }
  const id = decodeTaskId(argument)
  return Option.isSome(id)
    ? { kind: "id", id: id.value }
    : { kind: "title", title: argument.slice(0, TITLE_MAX) }
}

const normalized = (text: string): string => text.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim()

// The continuation of a task that is still under way, if any: a non-finished task that names `parentId` as its parent.
export const continuationOf = (
  records: ReadonlyArray<TaskRecord>,
  parentId: TaskId,
  except?: TaskId,
): TaskRecord | undefined =>
  records.find(
    (record) => record.spec.resumeOf === parentId && record.spec.id !== except && !isTerminal(record.state),
  )

// The tasks a request names. A title names the newest task of each chain: a task that another task continues is
// superseded by its continuation, so it is not a candidate. A title matches exactly when it can; otherwise every
// candidate whose title contains it. An id names that task whatever its place in a chain.
export const matchTasks = (
  records: ReadonlyArray<TaskRecord>,
  request: ResumeRequest,
): ReadonlyArray<TaskRecord> => {
  if (request.kind === "id") {
    return records.filter((record) => record.spec.id === request.id)
  }
  const superseded = new Set(
    records.flatMap((record) => (record.spec.resumeOf === undefined ? [] : [record.spec.resumeOf])),
  )
  const tips = records.filter((record) => !superseded.has(record.spec.id))
  const wanted = normalized(request.title)
  const exact = tips.filter((record) => normalized(record.spec.title) === wanted)
  return exact.length > 0 ? exact : tips.filter((record) => normalized(record.spec.title).includes(wanted))
}

// What a request comes to: nothing to continue, several candidates to choose from, a task still running (not
// continuable), or the one finished task to continue.
export type ResumePlan =
  | { readonly _tag: "None" }
  | { readonly _tag: "Ambiguous"; readonly records: ReadonlyArray<TaskRecord> }
  | { readonly _tag: "Running"; readonly record: TaskRecord }
  | { readonly _tag: "Resume"; readonly record: TaskRecord }

export const planResume = (matches: ReadonlyArray<TaskRecord>): ResumePlan => {
  const [only] = matches
  if (only === undefined) {
    return { _tag: "None" }
  }
  if (matches.length > 1) {
    return { _tag: "Ambiguous", records: matches }
  }
  return isTerminal(only.state) ? { _tag: "Resume", record: only } : { _tag: "Running", record: only }
}
