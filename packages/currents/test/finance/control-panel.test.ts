import { it } from "@effect/vitest"
import { Effect, Redacted, Schema } from "effect"
import { describe, expect } from "vitest"
import { ControlPanelConfig, controlPanelReader } from "../../src/control-panel/adapter.js"
import { controlPanelConnector } from "../../src/control-panel/connector.js"
import { authorizationOf, fixture, jsonResponse, recordingFetch } from "./support.js"

// Built at runtime so that no literal key-shaped string sits in the source (gitleaks).
const TOKEN = ["cp", "FAKETOKEN0001"].join("_")
const config = () => Schema.decodeUnknownSync(ControlPanelConfig)(fixture("control-panel/config.json"))

describe("control-panel reader", () => {
  it.effect("listProjects maps the fixture through the mapping, one neutral project per item", () =>
    Effect.gen(function* () {
      const { doFetch, calls } = recordingFetch(() => jsonResponse(fixture("control-panel/projects.json")))
      const reader = controlPanelReader({ config: config(), token: Redacted.make(TOKEN), fetch: doFetch })
      const projects = yield* reader.listProjects()
      expect(calls[0]?.url.toString()).toBe("https://control-panel.example.test/api/projects")
      expect(authorizationOf(calls[0] ?? { url: new URL("https://x.test"), init: {} })).toBe(
        `Bearer ${TOKEN}`,
      )
      expect(projects).toEqual([
        { id: "p-1", name: "Projeto Um" },
        { id: "p-2", name: "Projeto Dois" },
      ])
      expect(JSON.stringify(projects)).not.toContain("internal_owner")
    }),
  )

  it.effect("getProject reads one project by a path-encoded id", () =>
    Effect.gen(function* () {
      const { doFetch, calls } = recordingFetch(() => jsonResponse({ slug: "p-1", title: "Projeto Um" }))
      const reader = controlPanelReader({ config: config(), token: Redacted.make(TOKEN), fetch: doFetch })
      const project = yield* reader.getProject("p-1/../x")
      expect(calls[0]?.url.pathname).toBe("/api/projects/p-1%2F..%2Fx")
      expect(project).toEqual({ id: "p-1", name: "Projeto Um" })
    }),
  )

  it.effect("an answer that is not a project is invalid_response", () =>
    Effect.gen(function* () {
      const { doFetch } = recordingFetch(() => jsonResponse({ slug: "p-1" }))
      const reader = controlPanelReader({ config: config(), token: Redacted.make(TOKEN), fetch: doFetch })
      const error = yield* Effect.flip(reader.getProject("p-1"))
      expect(error.provider).toBe("control-panel")
      expect(error.reason).toBe("invalid_response")
    }),
  )

  it.effect("without config the reader is unavailable and building it does not throw", () =>
    Effect.gen(function* () {
      const reader = controlPanelReader()
      const error = yield* Effect.flip(reader.listProjects())
      expect(error.reason).toBe("unavailable")
      expect(error.op).toBe("control-panel.projects.list")
    }),
  )

  it("the connector boots without config: no tools, no triggers, no permissions", () => {
    expect(controlPanelConnector.id).toBe("control-panel")
    expect(controlPanelConnector.tools).toEqual([])
    expect(controlPanelConnector.permissions).toEqual([])
    expect(controlPanelConnector.triggers).toEqual([])
  })
})
