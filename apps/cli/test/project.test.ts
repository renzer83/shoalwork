import { it } from "@effect/vitest"
import { Effect } from "effect"
import { afterEach, describe, expect, vi } from "vitest"
import { UsageError } from "../src/args.js"
import { projectAdd, projectList, projectSync } from "../src/commands/project.js"

const SETTINGS = { url: "http://localhost:28900", token: "dev-token" }

const PROJECT = {
  slug: "faturium",
  name: "Faturium",
  repoUrl: "https://github.com/x/faturium",
  defaultBranch: "main",
  status: "active",
  maxInProgress: 3,
}

const stubFetch = (respond: () => Promise<Response>) => {
  const mock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => respond())
  vi.stubGlobal("fetch", mock)
  return mock
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const sentBody = (mock: ReturnType<typeof stubFetch>): Record<string, unknown> =>
  JSON.parse(String(mock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("project add", () => {
  it.effect("posts the project body and returns the created project", () =>
    Effect.gen(function* () {
      const mock = stubFetch(async () => json({ project: PROJECT }, 201))

      const created = yield* projectAdd(SETTINGS, {
        slug: "faturium",
        name: "Faturium",
        repo: "https://github.com/x/faturium",
      })

      expect(created).toEqual(PROJECT)
      const [url, init] = mock.mock.calls[0] ?? []
      expect(String(url)).toBe("http://localhost:28900/projects")
      expect(init?.method).toBe("POST")
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer dev-token")
      expect(sentBody(mock)).toEqual({
        slug: "faturium",
        name: "Faturium",
        repoUrl: "https://github.com/x/faturium",
        defaultBranch: "main",
      })
    }),
  )

  it.effect("sends --base and --max when they are given", () =>
    Effect.gen(function* () {
      const mock = stubFetch(async () => json({ project: PROJECT }, 201))

      yield* projectAdd(SETTINGS, {
        slug: "faturium",
        name: "Faturium",
        repo: "https://github.com/x/faturium",
        base: "dev",
        max: "5",
      })

      expect(sentBody(mock)).toMatchObject({ defaultBranch: "dev", maxInProgress: 5 })
    }),
  )

  it.effect("requires --slug, --name and --repo before any request", () =>
    Effect.gen(function* () {
      const mock = stubFetch(async () => json({ project: PROJECT }, 201))

      const error = yield* Effect.flip(projectAdd(SETTINGS, { name: "Faturium" }))

      expect(error).toBeInstanceOf(UsageError)
      expect(mock).not.toHaveBeenCalled()
    }),
  )
})

describe("project list", () => {
  it.effect("reads GET /projects with the bearer token and decodes the list", () =>
    Effect.gen(function* () {
      const mock = stubFetch(async () => json({ projects: [PROJECT] }))

      const projects = yield* projectList(SETTINGS)

      expect(projects).toEqual([PROJECT])
      expect(String(mock.mock.calls[0]?.[0])).toBe("http://localhost:28900/projects")
      expect(new Headers(mock.mock.calls[0]?.[1]?.headers).get("authorization")).toBe("Bearer dev-token")
    }),
  )
})

describe("project sync", () => {
  it.effect("posts to /projects/:slug/sync and returns the report", () =>
    Effect.gen(function* () {
      const mock = stubFetch(async () => json({ report: { project: "faturium", applied: 2, skipped: 1 } }))

      const report = yield* projectSync(SETTINGS, "faturium")

      expect(report).toEqual({ project: "faturium", applied: 2, skipped: 1 })
      expect(String(mock.mock.calls[0]?.[0])).toBe("http://localhost:28900/projects/faturium/sync")
    }),
  )
})
