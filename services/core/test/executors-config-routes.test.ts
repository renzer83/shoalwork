import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Redacted } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { parse } from "yaml"
import { makeApp } from "../src/http/app.js"
import type { RunEffect } from "../src/http/routes/respond.js"

const TOKEN = "test-token"
const AUTH = { authorization: `Bearer ${TOKEN}` }

const FIXTURE_YAML = `# Executor configuration fixture
executors:
  - id: claude-code
    kind: claude-code
  - id: codex
    kind: codex
    isDefault: true
`

describe("executors YAML configuration routes", () => {
  let tempDir: string
  let yamlPath: string
  let app: ReturnType<typeof makeApp>

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "shoalwork-executors-test-"))
    yamlPath = join(tempDir, "executors.yaml")
    writeFileSync(yamlPath, FIXTURE_YAML, "utf8")
    const runEffect: RunEffect = <A, E>(eff: Effect.Effect<A, E, never>): Promise<A> => Effect.runPromise(eff)
    app = makeApp({
      apiToken: Redacted.make(TOKEN),
      runEffect,
      executorsConfigPath: yamlPath,
    })
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("requires authorization", async () => {
    const resPatch = await app.request("/executors/claude-code", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    })
    expect(resPatch.status).toBe(401)

    const resPut = await app.request("/executors/routing", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ order: ["claude-code"] }),
    })
    expect(resPut.status).toBe(401)
  })

  it("PATCH /executors/:id updates enabled, priority, and isDefault", async () => {
    const response = await app.request("/executors/claude-code", {
      method: "PATCH",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ enabled: false, priority: 2, isDefault: true }),
    })

    expect(response.status).toBe(200)
    interface PatchResponse {
      readonly id?: string
      readonly enabled?: boolean
      readonly priority?: number
      readonly isDefault?: boolean
      readonly executor?: {
        readonly id?: string
        readonly enabled?: boolean
        readonly priority?: number
        readonly isDefault?: boolean
      }
    }
    const body = (await response.json()) as PatchResponse
    expect(body.executor?.id ?? body.id).toBe("claude-code")
    expect(body.executor?.enabled ?? body.enabled).toBe(false)
    expect(body.executor?.priority ?? body.priority).toBe(2)
    expect(body.executor?.isDefault ?? body.isDefault).toBe(true)

    // Check persistence in YAML
    const parsed = parse(readFileSync(yamlPath, "utf8")) as { executors: Array<Record<string, unknown>> }
    const claude = parsed.executors.find((e) => e.id === "claude-code")
    const codex = parsed.executors.find((e) => e.id === "codex")

    expect(claude?.enabled).toBe(false)
    expect(claude?.priority).toBe(2)
    expect(claude?.isDefault).toBe(true)
    // Codex had isDefault: true initially; claude taking default should clear codex default
    expect(codex?.isDefault).toBeUndefined()
  })

  it("PATCH /executors/:id with isDefault=false clears default", async () => {
    const response = await app.request("/executors/codex", {
      method: "PATCH",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ isDefault: false }),
    })

    expect(response.status).toBe(200)
    const parsed = parse(readFileSync(yamlPath, "utf8")) as { executors: Array<Record<string, unknown>> }
    const codex = parsed.executors.find((e) => e.id === "codex")
    expect(codex?.isDefault).toBeUndefined()
  })

  it("PATCH /executors/:id returns 404 for unknown executor", async () => {
    const response = await app.request("/executors/non-existent", {
      method: "PATCH",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    })
    expect(response.status).toBe(404)
  })

  it("PUT /executors/routing persists the order array", async () => {
    const order = ["codex", "claude-code"]
    const response = await app.request("/executors/routing", {
      method: "PUT",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ order }),
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { routing?: { order: unknown[] }; order?: unknown[] }
    expect(body.routing?.order ?? body.order).toEqual(order)

    // Check persistence in YAML
    const parsed = parse(readFileSync(yamlPath, "utf8")) as { routing?: { order: unknown[] } }
    expect(parsed.routing?.order).toEqual(order)
  })

  it("PUT /executors/routing returns 400 for invalid body", async () => {
    const response = await app.request("/executors/routing", {
      method: "PUT",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ order: "not-an-array" }),
    })
    expect(response.status).toBe(400)
  })
})
