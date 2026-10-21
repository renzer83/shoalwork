import type { MetricsCompare, ProjectSummary } from "@shoalwork/api-client"
import { Effect } from "effect"
import { useCallback, useEffect, useState } from "react"
import { useApi } from "../api-context.js"
import {
  countsOf,
  type Health,
  type HealthCounts,
  healthOf,
  statusOf,
} from "../components/project/project-model.js"

export interface ProjectRow extends ProjectSummary {
  readonly counts: HealthCounts
  readonly health: Health
}

export type ProjectsLoad =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly rows: ReadonlyArray<ProjectRow> }
  | { readonly kind: "failed"; readonly status: number }

// Every project with its health, read from its tasks (blocked = attention, work in flight = running).
export function useProjects(): { readonly load: ProjectsLoad; readonly reload: () => void } {
  const { client } = useApi()
  const [load, setLoad] = useState<ProjectsLoad>({ kind: "loading" })

  const reload = useCallback(() => {
    void (async () => {
      const list = await Effect.runPromise(Effect.result(client.projects.list()))
      if (list._tag === "Failure") {
        setLoad({ kind: "failed", status: statusOf(list.failure) })
        return
      }
      const rows = await Promise.all(
        list.success.projects.map(async (project): Promise<ProjectRow> => {
          const tasks = await Effect.runPromise(Effect.result(client.projects.tasks(project.slug)))
          if (tasks._tag === "Failure") {
            return { ...project, counts: { total: 0, running: 0, blocked: 0 }, health: "unknown" }
          }
          const counts = countsOf(tasks.success.tasks)
          return { ...project, counts, health: healthOf(counts) }
        }),
      )
      setLoad({ kind: "loaded", rows })
    })()
  }, [client])

  useEffect(() => {
    reload()
  }, [reload])

  return { load, reload }
}

export type MetricsLoad =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly value: MetricsCompare }
  | { readonly kind: "failed"; readonly status: number }

// The six factory measures of a project against its baseline (GET /metrics/compare).
export function useProjectMetrics(slug: string): { readonly load: MetricsLoad; readonly reload: () => void } {
  const { client } = useApi()
  const [load, setLoad] = useState<MetricsLoad>({ kind: "loading" })

  const reload = useCallback(() => {
    setLoad({ kind: "loading" })
    void Effect.runPromise(Effect.result(client.metrics.compare(slug))).then((result) => {
      setLoad(
        result._tag === "Success"
          ? { kind: "loaded", value: result.success }
          : { kind: "failed", status: statusOf(result.failure) },
      )
    })
  }, [client, slug])

  useEffect(() => {
    reload()
  }, [reload])

  return { load, reload }
}
