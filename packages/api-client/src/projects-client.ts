import type { ProjectTaskState } from "@shoalwork/contracts"
import type { ApiClient } from "./client.js"
import { BoardTaskList, BoardTaskOne, MetricsCompare, SprintList, SprintOne } from "./project-schemas.js"
import { ProjectList } from "./schemas.js"

// Body of POST /projects/:slug/sprints.
export interface NewSprintBody {
  readonly name: string
  readonly startsAt: string
  readonly endsAt: string
  readonly goal?: string
}

// Body of PATCH /projects/:slug/tasks/:taskId: one action per call.
export type TaskPatch =
  | { readonly move: { readonly to: ProjectTaskState; readonly reason?: string } }
  | { readonly retry: true }
  | { readonly pause: true }
  | { readonly sprintId: string | null }

const enc = encodeURIComponent

export const projectsApi = (client: ApiClient) => ({
  list: () => client.get("/projects", ProjectList),
  tasks: (slug: string) => client.get(`/projects/${enc(slug)}/tasks`, BoardTaskList),
  sprints: (slug: string) => client.get(`/projects/${enc(slug)}/sprints`, SprintList),
  createSprint: (slug: string, sprint: NewSprintBody) =>
    client.post(`/projects/${enc(slug)}/sprints`, sprint, SprintOne),
  patchTask: (slug: string, taskId: string, patch: TaskPatch) =>
    client.patch(`/projects/${enc(slug)}/tasks/${enc(taskId)}`, patch, BoardTaskOne),
})

export const metricsApi = (client: ApiClient) => ({
  compare: (project: string) => client.get(`/metrics/compare?project=${enc(project)}`, MetricsCompare),
})
