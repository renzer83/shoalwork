import {
  type ControlPanelProject,
  ControlPanelProject as ControlPanelProjectSchema,
  type ControlPanelReader,
} from "@shoalwork/contracts"
import { Effect, type Redacted, Schema } from "effect"
import {
  BaseUrl,
  type FetchLike,
  httpReader,
  ResourceMapping,
  readOne,
  readRecords,
  unavailable,
} from "../billing-gateway/adapter.js"

// Same generic reader as the billing-gateway (shared from ../billing-gateway/adapter.ts): the control-panel contract is
// not known yet (ADR-022), so its paths and its field mapping come from config.
export const ControlPanelConfig = Schema.Struct({
  baseUrl: BaseUrl,
  mapping: Schema.Struct({
    projects: ResourceMapping,
  }),
})
export type ControlPanelConfig = typeof ControlPanelConfig.Type

export interface ControlPanelOptions {
  readonly config: ControlPanelConfig
  readonly token: Redacted.Redacted<string>
  readonly fetch?: FetchLike | undefined
}

const PROJECT_FIELDS = ["id", "name"] as const

// Without options the reader exists and every call fails as "unavailable"; building it never throws.
export const controlPanelReader = (options?: ControlPanelOptions): ControlPanelReader => {
  if (options === undefined) {
    return {
      listProjects: () => unavailable("control-panel", "control-panel.projects.list"),
      getProject: () => unavailable("control-panel", "control-panel.project.get"),
    }
  }
  const http = httpReader({
    provider: "control-panel",
    baseUrl: options.config.baseUrl,
    token: options.token,
    fetch: options.fetch,
  })
  const { projects } = options.config.mapping
  return {
    listProjects: () =>
      Effect.gen(function* () {
        const op = "control-panel.projects.list"
        const answer = yield* http.get(op, projects.path, {})
        return yield* readRecords(
          "control-panel",
          op,
          answer,
          projects,
          PROJECT_FIELDS,
          ControlPanelProjectSchema,
        )
      }),
    getProject: (id) =>
      Effect.gen(function* () {
        const op = "control-panel.project.get"
        const answer = yield* http.get(op, `${projects.path}/${encodeURIComponent(id)}`, {})
        const project: ControlPanelProject = yield* readOne(
          "control-panel",
          op,
          answer,
          projects,
          PROJECT_FIELDS,
          ControlPanelProjectSchema,
        )
        return project
      }),
  }
}
