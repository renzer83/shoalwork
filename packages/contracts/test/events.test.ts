import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { describe, expect } from "vitest"
import { decodeNewEvent, Event, EventPayloads, EventType, NewEvent, streamIds } from "../src/events/index.js"
import { BotId, TaskId } from "../src/ids.js"

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"))

const BOT = "bot_3f2a9c1e-7b4d-4e8a-9f10-2c6d5e8b7a41"
const TASK = "task_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
const PLAN = "plan_1b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e"
const STEP = "step_2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f"
const EVT = "evt_4a5b6c7d-8e9f-4a0b-8c1d-2e3f4a5b6c7d"
const APR = "apr_5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e"
const POD = "pod_7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a"
const TIDE = "tide_6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f"
const ISO = "2026-10-19T12:00:00.000Z"
const BUDGET = { tokens: 50000, seconds: 900, usd: 0.5 }
const USAGE = { tokensIn: 1200, tokensOut: 300, cacheRead: 0, cacheWrite: 0, usd: 0.01, seconds: 42 }

const TASK_ID = Schema.decodeUnknownSync(TaskId)(TASK)

const EVENT_TYPES: ReadonlyArray<EventType> = [
  "task.received",
  "task.planned",
  "task.state_changed",
  "decision.made",
  "decision.outcome",
  "bot.created",
  "bot.state_changed",
  "executor.started",
  "executor.event",
  "executor.finished",
  "usage.recorded",
  "approval.requested",
  "approval.resolved",
  "policy.denied",
  "message.inbound",
  "message.outbound",
  "tide.fired",
  "tide.skipped",
  "watchdog.recovered",
  "budget.exceeded",
  "error.raised",
  "memory.added",
  "memory.superseded",
  "memory.forgotten",
  "control.changed",
  "bot.proposed",
  "bot.proposal_resolved",
  "context.assembled",
  "agent.msg",
  "github.issues",
  "github.pull_request",
  "github.workflow_run",
  "github.check_suite",
  "github.push",
  "pod.opened",
  "pod.closed",
  "step.verified",
  "review.decided",
  "project_task.state_changed",
]

// Keyed by EventType: the compiler fails if a type is missing.
const VALID: Record<EventType, Record<string, unknown>> = {
  "task.received": { task: fixture("task.json") },
  "task.planned": { taskId: TASK, planId: PLAN, stepCount: 3 },
  "task.state_changed": { taskId: TASK, from: "running", to: "verifying", reason: "steps done" },
  "decision.made": {
    decisionId: "dec_1",
    questionId: "q_parallelizable",
    kind: "noul",
    value: true,
    confidence: 0.9,
    source: "rule",
    facts: { steps: 3 },
  },
  "decision.outcome": { decisionId: "dec_1", outcome: "correct" },
  "bot.created": { bot: fixture("bot.json"), by: "user:renan" },
  "bot.state_changed": { botId: BOT, from: "idle", to: "working", taskId: TASK },
  "executor.started": {
    taskId: TASK,
    stepId: STEP,
    botId: BOT,
    executor: "claude-code",
    model: "haiku",
    sessionId: "sess-abc-123",
    cwd: "/work/tree",
  },
  "executor.event": { taskId: TASK, botId: BOT, event: { kind: "started", sessionId: "sess-abc-123" } },
  "executor.finished": { taskId: TASK, botId: BOT, verdict: fixture("verdict.json"), durationMs: 42000 },
  "usage.recorded": { taskId: TASK, botId: BOT, executor: "claude-code", model: "haiku", usage: USAGE },
  "approval.requested": {
    approvalId: APR,
    taskId: TASK,
    botId: BOT,
    action: { tool: "shell", input: { cmd: "git push" } },
    risk: "external",
    expiresAt: ISO,
  },
  "approval.resolved": { approvalId: APR, decision: "approved", by: "user:renan" },
  "policy.denied": { botId: BOT, tool: "shell", rule: "no-network" },
  "message.inbound": { channel: "telegram", chatId: "-100123", threadId: "42", userId: "7", text: "oi" },
  "message.outbound": { channel: "telegram", botId: BOT, text: "pronto", latencyMs: 350, inReplyTo: EVT },
  "tide.fired": { tideId: TIDE, botId: BOT, trigger: "cron", taskId: TASK },
  "tide.skipped": { tideId: TIDE, botId: BOT, reason: "cooldown" },
  "watchdog.recovered": { what: "stale_task", ref: TASK, action: "requeued" },
  "budget.exceeded": {
    scope: "task",
    refId: TASK,
    limit: BUDGET,
    used: { tokens: 60000, seconds: 100, usd: 0.4 },
  },
  "error.raised": { where: "tank.exec", tag: "TankError", message: "exit 1", taskId: TASK },
  "pod.opened": { podId: POD, taskId: TASK, threadId: 101, botIds: [BOT] },
  "pod.closed": {
    podId: POD,
    taskId: TASK,
    summary: "2 passo(s) auxiliar(es): 2 concluído(s), 0 falhou(aram).",
  },
  "step.verified": {
    taskId: TASK,
    planId: PLAN,
    stepId: STEP,
    tests: "pass",
    artifacts: "pass",
    final: "ok",
    notes: [],
  },
  "review.decided": {
    taskId: TASK,
    planId: PLAN,
    stepId: STEP,
    round: 1,
    decision: "fix",
    findings: 2,
    reason: "two blocking findings",
  },
  "memory.added": { id: "mem_1", scope: "bot", ownerId: BOT, kind: "semantic", source: "chat" },
  "memory.superseded": { id: "mem_1", supersededBy: "mem_2", scope: "bot", ownerId: BOT },
  "memory.forgotten": { id: "mem_1", scope: "global", ownerId: "global" },
  "control.changed": { scope: "global", action: "stop", by: "user:telegram:7", tasks: [TASK] },
  "bot.proposed": { proposalId: "prop_1", botName: "marketing", requestedBy: "7" },
  "bot.proposal_resolved": { proposalId: "prop_1", botName: "marketing", status: "confirmed" },
  "context.assembled": {
    taskId: TASK,
    level: "full",
    used: 5200,
    budget: 23000,
    dropped: [{ block: "code", items: 2 }],
  },
  "agent.msg": { kind: "result", from: BOT, taskId: TASK, verdict: fixture("verdict.json"), artifacts: [] },
  "github.issues": {
    deliveryId: "5f0c2a7e-1111-4a2b-9c3d-000000000001",
    repo: "renzer83/shoalwork",
    action: "opened",
    sender: "renzer83",
    url: "https://github.com/renzer83/shoalwork/pull/7",
    botAuthored: false,
    number: 3,
    title: "Add sum",
  },
  "github.pull_request": {
    deliveryId: "5f0c2a7e-1111-4a2b-9c3d-000000000001",
    repo: "renzer83/shoalwork",
    action: "opened",
    sender: "renzer83",
    url: "https://github.com/renzer83/shoalwork/pull/7",
    botAuthored: false,
    number: 7,
    title: "Add sum",
    state: "open",
    headBranch: "bot/dev/step_1",
  },
  "github.workflow_run": {
    deliveryId: "5f0c2a7e-1111-4a2b-9c3d-000000000001",
    repo: "renzer83/shoalwork",
    action: "opened",
    sender: "renzer83",
    url: "https://github.com/renzer83/shoalwork/pull/7",
    botAuthored: false,
    conclusion: "success",
    headBranch: "main",
  },
  "github.check_suite": {
    deliveryId: "5f0c2a7e-1111-4a2b-9c3d-000000000001",
    repo: "renzer83/shoalwork",
    action: "opened",
    sender: "renzer83",
    url: "https://github.com/renzer83/shoalwork/pull/7",
    botAuthored: false,
    conclusion: "failure",
  },
  "github.push": {
    deliveryId: "5f0c2a7e-1111-4a2b-9c3d-000000000001",
    repo: "renzer83/shoalwork",
    action: "opened",
    sender: "renzer83",
    url: "https://github.com/renzer83/shoalwork/pull/7",
    botAuthored: false,
    ref: "refs/heads/main",
  },
  "project_task.state_changed": { project: "faturium", taskId: "ptask_1", from: "backlog", to: "ready" },
}

// One required field per type; removing it must reject the payload.
const REQUIRED_FIELD: Record<EventType, string> = {
  "task.received": "task",
  "task.planned": "planId",
  "task.state_changed": "from",
  "decision.made": "confidence",
  "decision.outcome": "outcome",
  "bot.created": "by",
  "bot.state_changed": "to",
  "executor.started": "cwd",
  "executor.event": "taskId",
  "executor.finished": "durationMs",
  "usage.recorded": "usage",
  "approval.requested": "risk",
  "approval.resolved": "by",
  "policy.denied": "rule",
  "message.inbound": "text",
  "message.outbound": "botId",
  "tide.fired": "trigger",
  "tide.skipped": "reason",
  "watchdog.recovered": "action",
  "budget.exceeded": "refId",
  "error.raised": "message",
  "memory.added": "kind",
  "memory.superseded": "supersededBy",
  "memory.forgotten": "ownerId",
  "control.changed": "action",
  "bot.proposed": "requestedBy",
  "bot.proposal_resolved": "status",
  "context.assembled": "level",
  "agent.msg": "kind",
  "github.issues": "number",
  "github.pull_request": "number",
  "github.workflow_run": "deliveryId",
  "github.check_suite": "repo",
  "github.push": "ref",
  "pod.opened": "podId",
  "pod.closed": "summary",
  "step.verified": "final",
  "review.decided": "decision",
  "project_task.state_changed": "to",
}

// Probe schemas used to read decoded-output fields without casts.
const TaskAcceptanceProbe = Schema.Struct({
  task: Schema.Struct({ acceptance: Schema.Array(Schema.String) }),
})
const ExpiresAtProbe = Schema.Struct({ expiresAt: Schema.String })

const without = (obj: Record<string, unknown>, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key))

const envelope = (type: string, payload: unknown): Record<string, unknown> => ({
  streamId: streamIds.task(TASK_ID),
  type,
  payload,
  actor: "system:watchdog",
  correlationId: "corr_1",
})

describe("events", () => {
  it("EventType is exactly the 39 types", () => {
    expect(EVENT_TYPES).toHaveLength(39)
    expect(Object.keys(VALID).sort()).toEqual([...EVENT_TYPES].sort())
    for (const type of EVENT_TYPES) {
      expect(Schema.decodeUnknownSync(EventType)(type)).toBe(type)
    }
  })

  it("rejects an event type outside the closed list", () => {
    expect(() => Schema.decodeUnknownSync(EventType)("task.exploded")).toThrow()
  })

  for (const type of EVENT_TYPES) {
    it.effect(`decodes a valid ${type} payload to its encoded form`, () =>
      Effect.gen(function* () {
        const event = yield* decodeNewEvent(envelope(type, VALID[type]))
        expect(event.type).toBe(type)
        expect(event.payload).toEqual(VALID[type])
      }),
    )

    it.effect(`rejects ${type} with a missing field as where payload:${type}`, () =>
      Effect.gen(function* () {
        const err = yield* Effect.flip(
          decodeNewEvent(envelope(type, without(VALID[type], REQUIRED_FIELD[type]))),
        )
        expect(err._tag).toBe("SchemaViolation")
        expect(err.where).toBe(`payload:${type}`)
      }),
    )
  }

  it.effect("rejects an envelope whose type is outside the list with where event", () =>
    Effect.gen(function* () {
      const err = yield* Effect.flip(decodeNewEvent(envelope("task.exploded", {})))
      expect(err._tag).toBe("SchemaViolation")
      expect(err.where).toBe("event")
    }),
  )

  it.effect("rejects an envelope without actor with where event", () =>
    Effect.gen(function* () {
      const raw = without(envelope("task.planned", VALID["task.planned"]), "actor")
      const err = yield* Effect.flip(decodeNewEvent(raw))
      expect(err.where).toBe("event")
    }),
  )

  it.effect("rejects a decision.made value that is not boolean, string or number", () =>
    Effect.gen(function* () {
      const payload = { ...VALID["decision.made"], value: null }
      const err = yield* Effect.flip(decodeNewEvent(envelope("decision.made", payload)))
      expect(err.where).toBe("payload:decision.made")
    }),
  )

  it.effect("rejects approval.requested with an expiresAt that is not a date", () =>
    Effect.gen(function* () {
      const payload = { ...VALID["approval.requested"], expiresAt: "not-a-date" }
      const err = yield* Effect.flip(decodeNewEvent(envelope("approval.requested", payload)))
      expect(err._tag).toBe("SchemaViolation")
      expect(err.where).toBe("payload:approval.requested")
    }),
  )

  it.effect("stores approval.requested expiresAt as an ISO string, not a DateTime object", () =>
    Effect.gen(function* () {
      const event = yield* decodeNewEvent(envelope("approval.requested", VALID["approval.requested"]))
      expect(Schema.decodeUnknownSync(ExpiresAtProbe)(event.payload).expiresAt).toBe(ISO)
    }),
  )

  it.effect("applies the TaskSpec acceptance default inside task.received", () =>
    Effect.gen(function* () {
      const task = {
        id: TASK,
        botId: BOT,
        title: "no acceptance key",
        prompt: "p",
        kind: "code",
        budget: BUDGET,
        tier: "heavy",
        origin: "telegram",
      }
      const event = yield* decodeNewEvent(envelope("task.received", { task }))
      expect(Schema.decodeUnknownSync(TaskAcceptanceProbe)(event.payload).task.acceptance).toEqual([])
    }),
  )

  it.effect("drops keys the payload schema does not declare", () =>
    Effect.gen(function* () {
      const payload = { ...VALID["task.planned"], extra: "not in schema" }
      const event = yield* decodeNewEvent(envelope("task.planned", payload))
      expect(event.payload).toEqual(VALID["task.planned"])
    }),
  )

  it("NewEvent round-trips an envelope", () => {
    const raw = envelope("task.planned", VALID["task.planned"])
    expect(Schema.encodeSync(NewEvent)(Schema.decodeUnknownSync(NewEvent)(raw))).toEqual(raw)
  })

  it("Event round-trips a stored event (ISO string to DateTime and back)", () => {
    const raw = {
      ...envelope("task.planned", VALID["task.planned"]),
      id: EVT,
      version: 1,
      position: 1,
      occurredAt: ISO,
    }
    expect(Schema.encodeSync(Event)(Schema.decodeUnknownSync(Event)(raw))).toEqual(raw)
  })

  it("Event rejects a stored event without version", () => {
    const raw = { ...envelope("task.planned", VALID["task.planned"]), id: EVT, position: 1, occurredAt: ISO }
    expect(() => Schema.decodeUnknownSync(Event)(raw)).toThrow()
  })

  it("streamIds.task(id) starts with task:", () => {
    expect(streamIds.task(TASK_ID).startsWith("task:")).toBe(true)
    expect(streamIds.task(TASK_ID)).toBe(`task:${TASK}`)
  })

  it("streamIds.bot(id) starts with bot:", () => {
    expect(streamIds.bot(Schema.decodeUnknownSync(BotId)(BOT))).toBe(`bot:${BOT}`)
  })

  it("streamIds.system is the literal system", () => {
    expect(streamIds.system).toBe("system")
  })
})

describe("tide firing and skip payloads", () => {
  const firedBase = { tideId: TIDE, botId: BOT, taskId: TASK }

  it("tide.fired accepts the manual trigger next to cron and event, and rejects any other", () => {
    const fired = EventPayloads["tide.fired"]
    for (const trigger of ["cron", "event", "manual"]) {
      expect(Schema.decodeUnknownSync(fired)({ ...firedBase, trigger }).trigger).toBe(trigger)
    }
    expect(() => Schema.decodeUnknownSync(fired)({ ...firedBase, trigger: "webhook" })).toThrow()
  })

  it("tide.skipped accepts the four reasons and rejects any other", () => {
    const skipped = EventPayloads["tide.skipped"]
    for (const reason of ["cooldown", "cap", "disabled", "feedback"]) {
      expect(Schema.decodeUnknownSync(skipped)({ tideId: TIDE, botId: BOT, reason }).reason).toBe(reason)
    }
    expect(() => Schema.decodeUnknownSync(skipped)({ tideId: TIDE, botId: BOT, reason: "paused" })).toThrow()
  })
})
