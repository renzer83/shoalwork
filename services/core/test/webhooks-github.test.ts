import { createHmac } from "node:crypto"
import { Beacon, BeaconLive } from "@shoalwork/beacon"
import { withTempDb } from "@shoalwork/db/testing"
import { Effect, Layer, ManagedRuntime, Redacted, Stream } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { SqlError, UnknownError } from "effect/sql/SqlError"
import { Hono } from "hono"
import { afterEach, describe, expect, it } from "vitest"
import type { RunEffect } from "../src/http/routes/respond.js"
import { registerGithubWebhookRoutes } from "../src/http/routes/webhooks-github.js"

const SECRET = "test-webhook-secret"
const DELIVERY = "5f0c2a7e-1111-4a2b-9c3d-000000000001"
const MEGABYTE = 1024 * 1024

const PR_BODY = JSON.stringify({
  action: "opened",
  pull_request: {
    number: 7,
    title: "Add sum helper",
    state: "open",
    html_url: "https://github.com/renzer83/shoalwork-sandbox/pull/7",
    head: {
      ref: "bot/dev-demo/step_00000000-0000-4000-8000-000000000002",
      repo: { full_name: "renzer83/shoalwork-sandbox" },
    },
  },
  repository: { full_name: "renzer83/shoalwork-sandbox" },
  sender: { login: "renzer83" },
})

const sign = (body: string, secret = SECRET): string =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`

// The real Beacon over a fresh SQLite file, or one whose appends fail (the claim must then be rolled back).
const TestLayer = BeaconLive.pipe(Layer.provideMerge(withTempDb()))
const FailingLayer = Layer.effect(
  Beacon,
  Effect.gen(function* () {
    const real = yield* Beacon
    return {
      ...real,
      append: (event: Parameters<typeof real.append>[0], opts?: Parameters<typeof real.append>[1]) =>
        event.type === "error.raised"
          ? real.append(event, opts)
          : Effect.fail(
              new SqlError({ reason: new UnknownError({ message: "append failed", cause: undefined }) }),
            ),
    }
  }),
).pipe(Layer.provide(BeaconLive), Layer.provideMerge(withTempDb()))

const runtimes: Array<{ readonly dispose: () => Promise<void> }> = []

const harness = (options: { configured?: boolean; failAppend?: boolean } = {}) => {
  const configured = options.configured ?? true
  const runtime = ManagedRuntime.make(options.failAppend === true ? FailingLayer : TestLayer)
  runtimes.push(runtime)
  const runEffect: RunEffect = <A, E>(eff: Effect.Effect<A, E, Layer.Success<typeof TestLayer>>) =>
    runtime.runPromise(eff)
  const app = new Hono()
  registerGithubWebhookRoutes(app, runEffect, configured ? Redacted.make(SECRET) : undefined)
  const query = <A>(run: (sql: SqlClient) => Effect.Effect<A, unknown>) =>
    runtime.runPromise(Effect.flatMap(SqlClient, run).pipe(Effect.orDie))
  const events = () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const beacon = yield* Beacon
        return yield* Stream.runCollect(beacon.readAll())
      }),
    )
  const post = (
    body: string | Uint8Array,
    headers: {
      event?: string | undefined
      delivery?: string | undefined
      signature?: string | undefined
      length?: string
    } = {},
  ) => {
    const requestHeaders: Record<string, string> = { "content-type": "application/json" }
    const event = "event" in headers ? headers.event : "pull_request"
    const delivery = "delivery" in headers ? headers.delivery : DELIVERY
    const signature = "signature" in headers ? headers.signature : sign(typeof body === "string" ? body : "")
    if (event !== undefined) requestHeaders["x-github-event"] = event
    if (delivery !== undefined) requestHeaders["x-github-delivery"] = delivery
    if (signature !== undefined) requestHeaders["x-hub-signature-256"] = signature
    if (headers.length !== undefined) requestHeaders["content-length"] = headers.length
    return app.request("/webhooks/github", { method: "POST", headers: requestHeaders, body })
  }
  return { post, events, query }
}

const countOf = (events: ReadonlyArray<{ readonly type: string }>, type: string) =>
  events.filter((event) => event.type === type).length

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    await runtime.dispose()
  }
})

describe("POST /webhooks/github", () => {
  it("answers 503 and processes nothing when no secret is configured, even for a huge declared body", async () => {
    const { post, events } = harness({ configured: false })
    expect((await post(PR_BODY, { length: "999999999999" })).status).toBe(503)
    expect((await events()).map((event) => event.type)).toEqual(["error.raised"])
  })

  it("refuses a wrong signature with 401 and records error.raised without the body", async () => {
    const { post, events } = harness()
    const response = await post(PR_BODY, { signature: sign(PR_BODY, "wrong-secret") })
    expect(response.status).toBe(401)
    const recorded = await events()
    expect(recorded.map((event) => event.type)).toEqual(["error.raised"])
    expect(JSON.stringify(recorded)).not.toContain("Add sum helper")
  })

  it("a flood of 401s writes at most one error.raised, and every request still gets its 401", async () => {
    const { post, events } = harness()
    const responses = await Promise.all(
      Array.from({ length: 50 }, (_unused, index) => post(PR_BODY, { signature: sign(`${index}`, "bad") })),
    )
    expect(responses.map((response) => response.status)).toEqual(Array.from({ length: 50 }, () => 401))
    expect(countOf(await events(), "error.raised")).toBe(1)
  })

  it("refuses a missing signature with 401", async () => {
    const { post } = harness()
    expect((await post(PR_BODY, { signature: undefined })).status).toBe(401)
  })

  it("answers 400 to a Content-Length that is not a number, before reading the body", async () => {
    const { post } = harness()
    expect((await post(PR_BODY, { length: "12abc" })).status).toBe(400)
  })

  it("answers 413 to a declared body above the 5 MB ceiling, without reading it", async () => {
    const { post } = harness()
    const response = await post(PR_BODY, { length: String(5 * MEGABYTE + 1) })
    expect(response.status).toBe(413)
  })

  it("answers 413 to a streamed body above the ceiling that declares no length", async () => {
    const { post, events } = harness()
    const oversized = new Uint8Array(5 * MEGABYTE + 1)
    const response = await post(oversized, { signature: sign("") })
    expect(response.status).toBe(413)
    expect(countOf(await events(), "github.pull_request")).toBe(0)
  })

  it("records a verified pull_request as a minimal github.pull_request event flagged as the Bot's own", async () => {
    const { post, events } = harness()
    const response = await post(PR_BODY)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, type: "github.pull_request" })
    const recorded = (await events()).filter((event) => event.type === "github.pull_request")
    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.payload).toMatchObject({
      deliveryId: DELIVERY,
      repo: "renzer83/shoalwork-sandbox",
      action: "opened",
      number: 7,
      botAuthored: true,
    })
    expect(recorded[0]?.actor).toBe("github:renzer83")
    expect(JSON.stringify(recorded[0]?.payload)).not.toContain("body")
  })

  it("ignores a redelivery of the same id inside 24 h, with 200 and no second event", async () => {
    const { post, events } = harness()
    expect((await post(PR_BODY)).status).toBe(200)
    const again = await post(PR_BODY)
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ ok: true, duplicate: true })
    expect(countOf(await events(), "github.pull_request")).toBe(1)
  })

  it("a replay of the same signed body under a new delivery id is a duplicate too", async () => {
    const { post, events } = harness()
    expect((await post(PR_BODY, { delivery: "5f0c2a7e-1111-4a2b-9c3d-000000000002" })).status).toBe(200)
    const replay = await post(PR_BODY, { delivery: "5f0c2a7e-1111-4a2b-9c3d-000000000003" })
    expect(await replay.json()).toMatchObject({ duplicate: true })
    expect(countOf(await events(), "github.pull_request")).toBe(1)
  })

  it("two identical deliveries at the same time record one event", async () => {
    const { post, events } = harness()
    const [first, second] = await Promise.all([post(PR_BODY), post(PR_BODY)])
    expect([first.status, second.status]).toEqual([200, 200])
    expect(countOf(await events(), "github.pull_request")).toBe(1)
  })

  it("an append that fails leaves no claim behind, so the redelivery is processed", async () => {
    const { post, query } = harness({ failAppend: true })
    const response = await post(PR_BODY)
    expect(response.status).toBe(500)
    const rows = await query(
      (sql) => sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM webhook_deliveries`,
    )
    expect(rows[0]?.n).toBe(0)
  })

  it("answers 200 and records nothing for an event it does not handle", async () => {
    const { post, events } = harness()
    const response = await post("{}", { event: "ping" })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, ignored: "ping" })
    expect(await events()).toEqual([])
  })

  it("refuses a verified body that is not the expected shape with 400, recording the tag only", async () => {
    const { post, events } = harness()
    const response = await post('{"not":"a pr"}')
    expect(response.status).toBe(400)
    const recorded = (await events()).filter((event) => event.type === "error.raised")
    expect(recorded.map((event) => event.payload)).toEqual([
      expect.objectContaining({ where: "webhook.github", tag: "InvalidPayload" }),
    ])
  })

  it("refuses a missing X-GitHub-Event with 400", async () => {
    const { post } = harness()
    expect((await post(PR_BODY, { event: undefined })).status).toBe(400)
  })

  it("refuses a malformed delivery id with 400", async () => {
    const { post } = harness()
    expect((await post(PR_BODY, { delivery: "../../etc" })).status).toBe(400)
  })
})

// Installation deliveries keep github_installations in step (T-084).
const INSTALLATION_BODY = JSON.stringify({
  action: "created",
  installation: { id: 42, account: { login: "renzer83" } },
  repositories: [{ full_name: "renzer83/shoalwork-sandbox" }],
})
const DELIVERY_2 = "5f0c2a7e-1111-4a2b-9c3d-000000000002"
const DELIVERY_3 = "5f0c2a7e-1111-4a2b-9c3d-000000000003"

describe("POST /webhooks/github installation deliveries", () => {
  it("a signed installation.created writes the installation row and answers 200", async () => {
    const { post, query } = harness()
    const response = await post(INSTALLATION_BODY, { event: "installation" })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, type: "installation" })
    const rows = await query((sql) => sql`SELECT installation_id, account, repos FROM github_installations`)
    expect(rows).toEqual([
      { installation_id: 42, account: "renzer83", repos: '["renzer83/shoalwork-sandbox"]' },
    ])
  })

  it("a repeated delivery is acknowledged as a duplicate and changes nothing", async () => {
    const { post, query } = harness()
    await post(INSTALLATION_BODY, { event: "installation" })
    const repeat = await post(
      JSON.stringify({ action: "deleted", installation: { id: 42, account: { login: "renzer83" } } }),
      { event: "installation", delivery: DELIVERY },
    )
    expect(await repeat.json()).toEqual({ ok: true, duplicate: true })
    const rows = await query((sql) => sql<{ readonly repos: string }>`SELECT repos FROM github_installations`)
    expect(rows).toHaveLength(1)
  })

  it("installation_repositories patches the stored repos", async () => {
    const { post, query } = harness()
    await post(INSTALLATION_BODY, { event: "installation" })
    const added = JSON.stringify({
      action: "added",
      installation: { id: 42, account: { login: "renzer83" } },
      repositories_added: [{ full_name: "renzer83/second" }],
    })
    expect((await post(added, { event: "installation_repositories", delivery: DELIVERY_2 })).status).toBe(200)
    const rows = await query((sql) => sql`SELECT installation_id, account, repos FROM github_installations`)
    expect(rows).toEqual([
      {
        installation_id: 42,
        account: "renzer83",
        repos: '["renzer83/second","renzer83/shoalwork-sandbox"]',
      },
    ])
  })

  it("an installation body that is not the expected shape is refused with 400 and writes nothing", async () => {
    const { post, query } = harness()
    const response = await post('{"action":"created"}', { event: "installation", delivery: DELIVERY_3 })
    expect(response.status).toBe(400)
    const rows = await query((sql) => sql<{ readonly repos: string }>`SELECT repos FROM github_installations`)
    expect(rows).toEqual([])
  })
})

describe("github.installation event (T-084 R12)", () => {
  const installationEvents = (events: ReadonlyArray<{ readonly type: string; readonly payload: unknown }>) =>
    events.filter((event) => event.type === "github.installation")

  it("a signed installation.created appends one github.installation event alongside its row", async () => {
    const { post, events, query } = harness()
    await post(INSTALLATION_BODY, { event: "installation" })
    const recorded = installationEvents(await events())
    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.payload).toEqual({
      deliveryId: DELIVERY,
      installationId: 42,
      account: "renzer83",
      action: "created",
      repos: ["renzer83/shoalwork-sandbox"],
    })
    const rows = await query((sql) => sql`SELECT installation_id FROM github_installations`)
    expect(rows).toHaveLength(1)
  })

  it("a redelivery of the same delivery appends no second event and changes no row", async () => {
    const { post, events, query } = harness()
    await post(INSTALLATION_BODY, { event: "installation" })
    const repeat = await post(INSTALLATION_BODY, { event: "installation" })
    expect(await repeat.json()).toEqual({ ok: true, duplicate: true })
    expect(installationEvents(await events())).toHaveLength(1)
    expect(await query((sql) => sql`SELECT installation_id FROM github_installations`)).toHaveLength(1)
  })

  it("when the event cannot be appended, neither the row nor the claim is kept", async () => {
    const { post, events, query } = harness({ failAppend: true })
    const response = await post(INSTALLATION_BODY, { event: "installation" })
    expect(response.status).toBe(500)
    expect(installationEvents(await events())).toEqual([])
    expect(await query((sql) => sql`SELECT installation_id FROM github_installations`)).toEqual([])
    expect(await query((sql) => sql`SELECT delivery_id FROM webhook_deliveries`)).toEqual([])
  })
})
