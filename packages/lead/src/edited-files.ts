import type { BeaconShape } from "@shoalwork/beacon"
import { EventPayloads, streamIds, type TaskId } from "@shoalwork/contracts"
import { Effect, Option, Schema, Stream } from "effect"

const decodeEvent = Schema.decodeUnknownOption(EventPayloads["executor.event"])

const MAX_FILES = 20

// A path the executor reported, relative to the worktree: an absolute path under `root` is cut to its relative form,
// any other absolute path (outside the repo) and any path that climbs out is left out.
export const relativeToRoot = (path: string, root: string): string | undefined => {
  const rooted = root.endsWith("/") ? root : `${root}/`
  const relative = path.startsWith(rooted) ? path.slice(rooted.length) : path
  if (relative === "" || relative.startsWith("/") || relative.split("/").includes("..")) return undefined
  return relative.startsWith("./") ? relative.slice(2) : relative
}

// The files the earlier runs of a task edited (executor.event file_edit in the task's stream), the most recent first,
// at most MAX_FILES. A retry ranks the code near them: it is the work it continues. Never fails: without them the
// briefing is simply ranked on the prompt's files.
export const editedFiles = (
  beacon: BeaconShape,
  taskId: TaskId,
  root: string,
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.gen(function* () {
    const events = Array.from(yield* Stream.runCollect(beacon.readStream(streamIds.task(taskId), 0)))
    const files = new Set<string>()
    for (const event of events.reverse()) {
      if (event.type !== "executor.event") continue
      const payload = decodeEvent(event.payload)
      if (Option.isSome(payload) && payload.value.event.kind === "file_edit") {
        const path = relativeToRoot(payload.value.event.path, root)
        if (path !== undefined) files.add(path)
      }
      if (files.size >= MAX_FILES) break
    }
    return [...files]
  }).pipe(Effect.catch(() => Effect.succeed([])))
