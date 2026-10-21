import {
  type BoardTask,
  type NewSprintBody,
  type SprintView,
  subscribeEvents,
  type TaskPatch,
} from "@shoalwork/api-client"
import { ProjectTaskState } from "@shoalwork/contracts"
import { Effect, Option, Schema } from "effect"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useApi } from "../api-context.js"
import { failureText, statusOf } from "../components/project/project-model.js"

// Payloads of the board's events as the core writes them (contracts keep them in the core's factory module).
const StateChanged = Schema.Struct({ project: Schema.String, taskId: Schema.String, to: ProjectTaskState })
const SprintChanged = Schema.Struct({
  project: Schema.String,
  taskId: Schema.String,
  to: Schema.NullOr(Schema.String),
})
const ProjectOf = Schema.Struct({ project: Schema.String })

export type BoardLoad =
  | { readonly kind: "loading" }
  | {
      readonly kind: "loaded"
      readonly tasks: ReadonlyArray<BoardTask>
      readonly sprints: ReadonlyArray<SprintView>
      readonly repoUrl: string
    }
  | { readonly kind: "failed"; readonly status: number }

export interface Board {
  readonly load: BoardLoad
  readonly notice: string | null
  readonly reload: () => void
  readonly patch: (taskId: string, action: TaskPatch) => void
  readonly createSprint: (sprint: NewSprintBody) => void
}

interface Snapshot {
  readonly tasks: ReadonlyArray<BoardTask>
  readonly sprints: ReadonlyArray<SprintView>
  readonly repoUrl: string
}

// The board of one project: tasks and sprints, actions through the core, and the live feed of its events.
export function useBoard(slug: string): Board {
  const { client } = useApi()
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [failure, setFailure] = useState<number | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const latest = useRef<Snapshot | null>(null)
  latest.current = snapshot

  const reload = useCallback(() => {
    setFailure(null)
    void Effect.runPromise(
      Effect.all({
        tasks: Effect.result(client.projects.tasks(slug)),
        sprints: Effect.result(client.projects.sprints(slug)),
        projects: Effect.result(client.projects.list()),
      }),
    ).then(({ tasks, sprints, projects }) => {
      if (tasks._tag === "Failure") {
        setFailure(statusOf(tasks.failure))
        return
      }
      const repoUrl =
        projects._tag === "Success"
          ? (projects.success.projects.find((p) => p.slug === slug)?.repoUrl ?? "")
          : ""
      setSnapshot({
        tasks: tasks.success.tasks,
        sprints: sprints._tag === "Success" ? sprints.success.sprints : [],
        repoUrl,
      })
    })
  }, [client, slug])

  useEffect(() => {
    reload()
  }, [reload])

  // A move of this project moves its card; a change the screen cannot place reloads the board.
  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      const types = ["project_task.state_changed", "project_task.sprint_changed", "sprint.created"] as const
      for await (const event of subscribeEvents(client, { types: [...types], signal: controller.signal })) {
        const now = new Date().toISOString()
        if (event.type === "sprint.created") {
          if (Option.isSome(Schema.decodeUnknownOption(ProjectOf)(event.payload))) reload()
          continue
        }
        const known = (taskId: string) => latest.current?.tasks.some((t) => t.id === taskId) === true
        if (event.type === "project_task.state_changed") {
          const moved = Option.getOrUndefined(Schema.decodeUnknownOption(StateChanged)(event.payload))
          if (moved === undefined || moved.project !== slug) continue
          if (!known(moved.taskId)) reload()
          setSnapshot((prev) =>
            prev === null
              ? prev
              : {
                  ...prev,
                  tasks: prev.tasks.map((t) =>
                    t.id === moved.taskId ? { ...t, state: moved.to, updatedAt: now } : t,
                  ),
                },
          )
        } else {
          const changed = Option.getOrUndefined(Schema.decodeUnknownOption(SprintChanged)(event.payload))
          if (changed === undefined || changed.project !== slug) continue
          if (!known(changed.taskId)) reload()
          setSnapshot((prev) =>
            prev === null
              ? prev
              : {
                  ...prev,
                  tasks: prev.tasks.map((t) =>
                    t.id === changed.taskId ? { ...t, sprintId: changed.to } : t,
                  ),
                },
          )
        }
      }
    })().catch(() => undefined)
    return () => controller.abort()
  }, [client, slug, reload])

  const patch = useCallback(
    (taskId: string, action: TaskPatch) => {
      setNotice(null)
      void Effect.runPromise(Effect.result(client.projects.patchTask(slug, taskId, action))).then(
        (result) => {
          if (result._tag === "Success") {
            const task = result.success.task
            setSnapshot((prev) =>
              prev === null ? prev : { ...prev, tasks: prev.tasks.map((t) => (t.id === task.id ? task : t)) },
            )
          } else {
            setNotice(failureText(result.failure))
          }
        },
      )
    },
    [client, slug],
  )

  const createSprint = useCallback(
    (sprint: NewSprintBody) => {
      setNotice(null)
      void Effect.runPromise(Effect.result(client.projects.createSprint(slug, sprint))).then((result) => {
        if (result._tag === "Success") reload()
        else setNotice(failureText(result.failure))
      })
    },
    [client, slug, reload],
  )

  const load = useMemo<BoardLoad>(() => {
    if (failure !== null) return { kind: "failed", status: failure }
    if (snapshot === null) return { kind: "loading" }
    return { kind: "loaded", ...snapshot }
  }, [failure, snapshot])

  return { load, notice, reload, patch, createSprint }
}
