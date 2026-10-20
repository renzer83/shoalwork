import { withTempDb } from "@shoalwork/db/testing"
import { Effect, ManagedRuntime, Redacted, Schema } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import { afterAll, describe, expect, it } from "vitest"
import { APP_VERSION } from "../src/config.js"
import { makeApp, type ProbeEffect } from "../src/http/app.js"

const TOKEN = "test-token"

// Real SQLite file per runtime (migrations applied); disposed after the suite.
const runtime = ManagedRuntime.make(withTempDb())
afterAll(() => runtime.dispose())

const runEffect = <A, E>(eff: Effect.Effect<A, E, SqlClient>): Promise<A> => runtime.runPromise(eff)

const appWith = (probe?: ProbeEffect) => makeApp({ apiToken: Redacted.make(TOKEN), runEffect, probe })

describe("GET /health", () => {
  it("returns 200 with the database status when the probe succeeds", async () => {
    const res = await appWith().request("/health")

    expect(res.status).toBe(200)
    const body: unknown = await res.json()
    expect(body).toMatchObject({
      ok: true,
      version: APP_VERSION,
      db: "ok",
      journalMode: "wal",
    })
    const { dbPath, uptimeSeconds } = Schema.decodeUnknownSync(
      Schema.Struct({ dbPath: Schema.String, uptimeSeconds: Schema.Number }),
    )(body)
    expect(dbPath).toMatch(/^shoalwork-test-.+\.db$/)
    expect(uptimeSeconds).toBeGreaterThanOrEqual(0)
  })

  it("returns 503 with db error when the probe fails", async () => {
    const res = await appWith(Effect.fail(new Error("disk I/O error"))).request("/health")

    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ ok: false, db: "error", dbPath: null, journalMode: null })
  }, 10_000)

  it("returns 503 when the probe does not answer within 2 seconds", async () => {
    const res = await appWith(Effect.never).request("/health")

    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ ok: false, db: "error" })
  }, 10_000)

  it("answers without a bearer token", async () => {
    const res = await appWith().request("/health")

    expect(res.status).toBe(200)
  })
})

describe("bearer auth", () => {
  const withWhoami = () => {
    const app = appWith()
    app.get("/whoami", (c) => c.json({ ok: true }))
    return app
  }

  it("rejects a protected route without a token with 401", async () => {
    const res = await withWhoami().request("/whoami")

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "unauthorized" })
  })

  it("rejects a wrong token with 401", async () => {
    const res = await withWhoami().request("/whoami", { headers: { Authorization: "Bearer wrong-token" } })

    expect(res.status).toBe(401)
  })

  it("lets a protected route through with the right token", async () => {
    const res = await withWhoami().request("/whoami", { headers: { Authorization: `Bearer ${TOKEN}` } })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})
