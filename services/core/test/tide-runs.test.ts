import { Beacon, BeaconLive } from "@shoalwork/beacon"
import { newBotId, newTaskId, newTideId, streamIds, type TaskId, type TideId } from "@shoalwork/contracts"
import { withTempDb } from "@shoalwork/db/testing"
import { Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect"
import { afterAll, describe, expect, it } from "vitest"
import { makeApp } from "../src/http/app.js"

const TOKEN = "test-token"
const AUTH = { authorization: `Bearer ${TOKEN}` }

const runtime = ManagedRuntime.make(BeaconLive.pipe(Layer.provideMerge(withTempDb())))
afterAll(() => runtime.dispose())

const runEffect = <A, E>(eff: Effect.Effect<A, E, never>): Promise<A> => runtime.runPromise(eff)
const app = makeApp({ apiToken: Redacted.make(TOKEN), runEffect })

const Runs = Schema.Struct({
  runs: Schema.Array(Schema.Struct({ at: Schema.String, taskId: Schema.String, trigger: Schema.String })),
})

// A firing is recorded on the task's stream, as the Tides do when they create the task.
const recordFiring = (tideId: TideId, taskId: TaskId, trigger: "cron" | "event" | "manual") =>
  runtime.runPromise(
    Effect.gen(function* () {
      yield* (yield* Beacon).append({
        streamId: streamIds.task(taskId),
        type: "tide.fired",
        payload: { tideId, botId: newBotId(), trigger, taskId },
        actor: "system:tides",
        correlationId: taskId,
      })
    }),
  )

describe("tide runs route", () => {
  it("requires the API token", async () => {
    expect((await app.request(`/tides/${newTideId()}/runs`)).status).toBe(401)
  })

  it("lists the firings of one Tide, and not those of another", async () => {
    const tide = newTideId()
    const other = newTideId()
    const first = newTaskId()
    const second = newTaskId()
    await recordFiring(tide, first, "cron")
    await recordFiring(other, newTaskId(), "event")
    await recordFiring(tide, second, "manual")

    const body = Schema.decodeUnknownSync(Runs)(
      await (await app.request(`/tides/${tide}/runs`, { headers: AUTH })).json(),
    )
    expect(body.runs.map((run) => run.taskId).sort()).toEqual([first, second].sort())
    expect(body.runs.map((run) => run.trigger).sort()).toEqual(["cron", "manual"])
    expect(body.runs.every((run) => run.at.endsWith("Z"))).toBe(true)
  })

  it("answers an empty list for a Tide that has never fired", async () => {
    const body = Schema.decodeUnknownSync(Runs)(
      await (await app.request(`/tides/${newTideId()}/runs`, { headers: AUTH })).json(),
    )
    expect(body.runs).toEqual([])
  })
})
