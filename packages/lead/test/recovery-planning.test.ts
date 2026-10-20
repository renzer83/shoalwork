import { it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import { Control } from "../src/control.js"
import { PLANNING_RESTART_REASON } from "../src/control-recovery.js"
import {
  allEvents,
  createBot,
  eventsOf,
  fakeExecutor,
  Lead,
  leadLayer,
  OK_EVENTS,
  specFor,
} from "./support.js"

const layer = leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS)) })

describe("Control.recoverOrphans: tasks left in planning", () => {
  it.live("fails a task a restart caught in planning with a blocked verdict and closes its jobs", () =>
    Effect.gen(function* () {
      const lead = yield* Lead
      const control = yield* Control
      const sql = yield* SqlClient
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot))
      yield* sql`UPDATE tasks SET state = 'planning' WHERE id = ${spec.id}`
      const untouched = yield* lead.intake(specFor(bot, { title: "waits" }))

      const report = yield* control.recoverOrphans()

      expect(report).toEqual({ resumed: [], failed: [spec.id] })
      const view = yield* lead.get(spec.id)
      expect(view.state).toBe("failed")
      expect(view.verdict?.kind).toBe("blocked")
      expect(view.verdict?.summary).toBe(PLANNING_RESTART_REASON)
      expect((yield* lead.get(untouched.id)).state).toBe("received")
      const jobs = yield* sql<{ readonly state: string }>`
        SELECT state FROM jobs WHERE json_extract(payload, '$.taskId') = ${spec.id}`
      expect(jobs.map((job) => job.state)).toEqual(["failed"])
      const events = yield* allEvents
      const changed = Array.from(events).filter((event) => event.type === "task.state_changed")
      expect(JSON.stringify(changed.map((event) => event.payload))).toContain(PLANNING_RESTART_REASON)
      // Idempotent: nothing is left to recover on a second boot.
      expect((yield* control.recoverOrphans()).failed).toEqual([])
    }).pipe(Effect.provide(layer)),
  )
})
