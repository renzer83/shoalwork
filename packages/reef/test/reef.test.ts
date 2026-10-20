import { it } from "@effect/vitest"
import { Beacon } from "@shoalwork/beacon"
import { NotFound, newEventId, SchemaViolation, TaskId } from "@shoalwork/contracts"
import { Effect, Exit, Layer, Schema, Stream } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import { Embedder, EmbedError } from "../src/embedder.js"
import { Reef } from "../src/reef.js"
import { EMBED_DIMS } from "../src/rows.js"
import { axis, fixtureEmbedder, reefStack, setFailAppend } from "./support.js"

const BOT_A = { scope: "bot", ownerId: "bot_a" } as const
const BOT_B = { scope: "bot", ownerId: "bot_b" } as const
const GLOBAL = { scope: "global", ownerId: "global" } as const
const TASK = Schema.decodeUnknownSync(TaskId)("task_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d")
const ReasonProbe = Schema.Struct({ reason: Schema.String })
const reasonOf = (payload: unknown): string => Schema.decodeUnknownSync(ReasonProbe)(payload).reason

describe("remember and search", () => {
  it.effect("stores a normalized 1024-dim embedding and finds the item by an exact word", () =>
    Effect.gen(function* () {
      const reef = yield* Reef
      const item = yield* reef.remember({
        ...BOT_A,
        kind: "semantic",
        content: "O gato preto dorme no sofá",
        source: "chat",
      })
      expect(item.id).toMatch(/^mem_/)
      expect(item.confidence).toBe(1)
      expect(item.superseded_by).toBeNull()
      expect(item.tombstone).toBe(0)
      const sql = yield* SqlClient
      expect(yield* sql`SELECT length(embedding) AS n FROM memory_items WHERE id = ${item.id}`).toEqual([
        { n: EMBED_DIMS * 4 },
      ])
      expect("embedding" in item).toBe(false)
      const hits = yield* reef.search("sofá", { scopes: [BOT_A] })
      expect(hits.map((h) => h.id)).toEqual([item.id])
      expect(hits[0]?.score).toBeGreaterThan(0)
    }).pipe(Effect.provide(reefStack())),
  )

  it.effect("finds a paraphrase that shares no word with the stored text", () => {
    const placed = {
      "the car needs new brakes": axis(0),
      automobile: axis(0),
    }
    return Effect.gen(function* () {
      const reef = yield* Reef
      const car = yield* reef.remember({
        ...BOT_A,
        kind: "semantic",
        content: "the car needs new brakes",
        source: "t",
      })
      yield* reef.remember({
        ...BOT_A,
        kind: "semantic",
        content: "quarterly tax filing is due",
        source: "t",
      })
      const hits = yield* reef.search("automobile", { scopes: [BOT_A] })
      expect(hits.map((h) => h.id)).toEqual([car.id])
    }).pipe(Effect.provide(reefStack(fixtureEmbedder(placed))))
  })

  it.effect("isolates scopes: a Bot never sees another Bot's memory, global is opt-in", () =>
    Effect.gen(function* () {
      const reef = yield* Reef
      const a = yield* reef.remember({
        ...BOT_A,
        kind: "semantic",
        content: "shared keyword apple",
        source: "t",
      })
      const b = yield* reef.remember({
        ...BOT_B,
        kind: "semantic",
        content: "shared keyword apple",
        source: "t",
      })
      const g = yield* reef.remember({
        ...GLOBAL,
        kind: "semantic",
        content: "shared keyword apple",
        source: "t",
      })
      expect((yield* reef.search("apple", { scopes: [BOT_A] })).map((h) => h.id)).toEqual([a.id])
      expect((yield* reef.search("apple", { scopes: [BOT_B] })).map((h) => h.id)).toEqual([b.id])
      const both = yield* reef.search("apple", { scopes: [BOT_A, GLOBAL] })
      expect(both.map((h) => h.id).sort()).toEqual([a.id, g.id].sort())
    }).pipe(Effect.provide(reefStack())),
  )

  it.effect("fails with EmbedError and stores nothing when the embedder is down", () => {
    const failing = Layer.succeed(Embedder, {
      dims: EMBED_DIMS,
      embed: () => Effect.fail(new EmbedError({ reason: "timeout", detail: "slow" })),
    })
    return Effect.gen(function* () {
      const reef = yield* Reef
      const sql = yield* SqlClient
      const error = yield* Effect.flip(
        reef.remember({ ...BOT_A, kind: "semantic", content: "x", source: "t" }),
      )
      expect(error).toBeInstanceOf(EmbedError)
      expect(yield* sql`SELECT count(*) AS n FROM memory_items`).toEqual([{ n: 0 }])
    }).pipe(Effect.provide(reefStack(failing)))
  })
})

describe("supersede and history", () => {
  it.effect("hides the old item from search and history shows both, oldest first", () =>
    Effect.gen(function* () {
      const reef = yield* Reef
      const v1 = yield* reef.remember({
        ...BOT_A,
        kind: "semantic",
        content: "lives in Lisbon",
        source: "chat",
      })
      const v2 = yield* reef.supersede(v1.id, {
        ...BOT_A,
        kind: "semantic",
        content: "lives in Porto",
        source: "chat",
      })
      expect((yield* reef.search("lives", { scopes: [BOT_A] })).map((h) => h.id)).toEqual([v2.id])
      expect((yield* reef.search("Lisbon", { scopes: [BOT_A] })).map((h) => h.id)).not.toContain(v1.id)
      const fromOld = yield* reef.history(v1.id)
      const fromNew = yield* reef.history(v2.id)
      expect(fromOld.map((m) => m.id)).toEqual([v1.id, v2.id])
      expect(fromNew.map((m) => m.id)).toEqual([v1.id, v2.id])
      expect(fromOld[0]?.superseded_by).toBe(v2.id)
    }).pipe(Effect.provide(reefStack())),
  )

  it.effect("chains three versions and rejects superseding a version that is no longer live", () =>
    Effect.gen(function* () {
      const reef = yield* Reef
      const sql = yield* SqlClient
      const draft = { ...BOT_A, kind: "semantic", source: "chat" } as const
      const v1 = yield* reef.remember({ ...draft, content: "v1 text" })
      const v2 = yield* reef.supersede(v1.id, { ...draft, content: "v2 text" })
      const v3 = yield* reef.supersede(v2.id, { ...draft, content: "v3 text" })
      expect((yield* reef.history(v2.id)).map((m) => m.id)).toEqual([v1.id, v2.id, v3.id])
      const error = yield* Effect.flip(reef.supersede(v1.id, { ...draft, content: "fork" }))
      expect(error).toBeInstanceOf(NotFound)
      expect(yield* sql`SELECT count(*) AS n FROM memory_items`).toEqual([{ n: 3 }])
    }).pipe(Effect.provide(reefStack())),
  )

  it.effect("fails with NotFound for an unknown id and leaves no row behind", () =>
    Effect.gen(function* () {
      const reef = yield* Reef
      const sql = yield* SqlClient
      const error = yield* Effect.flip(
        reef.supersede("mem_missing", { ...BOT_A, kind: "semantic", content: "new", source: "t" }),
      )
      expect(error).toBeInstanceOf(NotFound)
      expect(yield* sql`SELECT count(*) AS n FROM memory_items`).toEqual([{ n: 0 }])
    }).pipe(Effect.provide(reefStack())),
  )

  it.effect("history of an unknown id is empty", () =>
    Effect.gen(function* () {
      const reef = yield* Reef
      expect(yield* reef.history("mem_missing")).toEqual([])
    }).pipe(Effect.provide(reefStack())),
  )
})

describe("forget", () => {
  it.effect("tombstones the item: gone from search, row and history kept", () =>
    Effect.gen(function* () {
      const reef = yield* Reef
      const sql = yield* SqlClient
      const item = yield* reef.remember({
        ...BOT_A,
        kind: "semantic",
        content: "password hint banana",
        source: "t",
      })
      yield* reef.forget(item.id)
      expect(yield* reef.search("banana", { scopes: [BOT_A] })).toEqual([])
      expect(yield* sql`SELECT tombstone FROM memory_items WHERE id = ${item.id}`).toEqual([{ tombstone: 1 }])
      expect((yield* reef.history(item.id)).map((m) => m.id)).toEqual([item.id])
    }).pipe(Effect.provide(reefStack())),
  )

  it.effect("is idempotent, rejects unknown ids and blocks superseding a forgotten item", () =>
    Effect.gen(function* () {
      const reef = yield* Reef
      const item = yield* reef.remember({ ...BOT_A, kind: "semantic", content: "temp", source: "t" })
      yield* reef.forget(item.id)
      yield* reef.forget(item.id)
      expect(yield* Effect.flip(reef.forget("mem_missing"))).toBeInstanceOf(NotFound)
      const error = yield* Effect.flip(
        reef.supersede(item.id, { ...BOT_A, kind: "semantic", content: "again", source: "t" }),
      )
      expect(error).toBeInstanceOf(NotFound)
    }).pipe(Effect.provide(reefStack())),
  )
})

describe("memory events", () => {
  it.effect("emits added, superseded and forgotten without the content", () =>
    Effect.gen(function* () {
      const reef = yield* Reef
      const beacon = yield* Beacon
      const v1 = yield* reef.remember({ ...BOT_A, kind: "episodic", content: "secret body", source: "task" })
      const v2 = yield* reef.supersede(v1.id, {
        ...BOT_A,
        kind: "episodic",
        content: "other body",
        source: "task",
      })
      yield* reef.forget(v2.id)
      const events = yield* Stream.runCollect(
        beacon.readAll(0, ["memory.added", "memory.superseded", "memory.forgotten"]),
      )
      expect(events.map((e) => e.type)).toEqual([
        "memory.added",
        "memory.added",
        "memory.superseded",
        "memory.forgotten",
      ])
      expect(events[0]?.payload).toEqual({
        id: v1.id,
        scope: "bot",
        ownerId: "bot_a",
        kind: "episodic",
        source: "task",
      })
      expect(events[2]?.payload).toEqual({
        id: v1.id,
        supersededBy: v2.id,
        scope: "bot",
        ownerId: "bot_a",
      })
      expect(JSON.stringify(events)).not.toContain("secret body")
      expect(events.every((e) => e.streamId === "memory:bot:bot_a" && e.actor === "reef")).toBe(true)
    }).pipe(Effect.provide(reefStack())),
  )
})

describe("workingContext", () => {
  const append = (taskId: string, reason: string) =>
    Effect.gen(function* () {
      const beacon = yield* Beacon
      return yield* beacon.append({
        streamId: `task:${taskId}`,
        type: "task.state_changed",
        payload: { taskId, from: "running", to: "verifying", reason },
        actor: "test",
        correlationId: newEventId(),
      })
    })

  it.effect("returns the last n events of the task stream, oldest first", () =>
    Effect.gen(function* () {
      const reef = yield* Reef
      for (const reason of ["one", "two", "three", "four", "five"]) {
        yield* append(TASK, reason)
      }
      yield* append("task_ffffffff-4e5f-4a6b-8c7d-9e0f1a2b3c4d", "other task")
      const last = yield* reef.workingContext(TASK, 3)
      expect(last.map((e) => e.version)).toEqual([3, 4, 5])
      expect(last.map((e) => reasonOf(e.payload))).toEqual(["three", "four", "five"])
      expect((yield* reef.workingContext(TASK, 99)).map((e) => e.version)).toEqual([1, 2, 3, 4, 5])
      expect(yield* reef.workingContext(TASK, 0)).toEqual([])
    }).pipe(Effect.provide(reefStack())),
  )

  it.effect("is empty for a task with no events", () =>
    Effect.gen(function* () {
      const reef = yield* Reef
      expect(yield* reef.workingContext(TASK, 5)).toEqual([])
    }).pipe(Effect.provide(reefStack())),
  )
})

describe("scope inheritance on supersede", () => {
  it.effect("the successor keeps the scope and owner of the old item even if the input carries others", () =>
    Effect.gen(function* () {
      const reef = yield* Reef
      const v1 = yield* reef.remember({ ...BOT_A, kind: "semantic", content: "owned by A", source: "t" })
      // Not a fresh literal, so TypeScript lets the extra scope/ownerId through; the Reef must ignore them.
      const hostile = { ...BOT_B, kind: "semantic", content: "stolen by B", source: "t" } as const
      const v2 = yield* reef.supersede(v1.id, hostile)
      expect(v2).toMatchObject({ scope: "bot", owner_id: "bot_a" })
      expect((yield* reef.search("stolen", { scopes: [BOT_A] })).map((h) => h.id)).toEqual([v2.id])
      expect(yield* reef.search("stolen", { scopes: [BOT_B] })).toEqual([])
    }).pipe(Effect.provide(reefStack())),
  )
})

describe("input validation", () => {
  const valid = { ...BOT_A, kind: "semantic", content: "ok", source: "t" } as const

  it.effect(
    "rejects empty content, empty owner, out-of-range confidence and a global item with another owner",
    () =>
      Effect.gen(function* () {
        const reef = yield* Reef
        const sql = yield* SqlClient
        const bad = [
          { ...valid, content: "   " },
          { ...valid, ownerId: " " },
          { ...valid, confidence: 1.5 },
          { ...valid, confidence: -0.1 },
          { ...valid, confidence: Number.NaN },
          { ...valid, confidence: Number.POSITIVE_INFINITY },
          { ...valid, scope: "global", ownerId: "bot_a" },
        ] as const
        for (const item of bad) {
          expect(yield* Effect.flip(reef.remember(item))).toBeInstanceOf(SchemaViolation)
        }
        expect(yield* sql`SELECT count(*) AS n FROM memory_items`).toEqual([{ n: 0 }])
        yield* reef.remember({ ...valid, confidence: 0 })
        yield* reef.remember({ ...valid, confidence: 1 })
        yield* reef.remember({ ...GLOBAL, kind: "semantic", content: "global ok", source: "t" })
      }).pipe(Effect.provide(reefStack())),
  )

  it.effect("supersede validates content and confidence before touching anything", () =>
    Effect.gen(function* () {
      const reef = yield* Reef
      const v1 = yield* reef.remember(valid)
      const next = { kind: "semantic", source: "t" } as const
      expect(yield* Effect.flip(reef.supersede(v1.id, { ...next, content: "" }))).toBeInstanceOf(
        SchemaViolation,
      )
      expect(
        yield* Effect.flip(reef.supersede(v1.id, { ...next, content: "x", confidence: 2 })),
      ).toBeInstanceOf(SchemaViolation)
      expect((yield* reef.history(v1.id)).map((m) => m.id)).toEqual([v1.id])
    }).pipe(Effect.provide(reefStack())),
  )

  it.effect(
    "remember fails with EmbedError reason shape when the embedder returns the wrong dimension",
    () => {
      const wrong = Layer.succeed(Embedder, {
        dims: EMBED_DIMS,
        embed: (texts) => Effect.succeed(texts.map(() => [1, 0, 0])),
      })
      return Effect.gen(function* () {
        const reef = yield* Reef
        const error = yield* Effect.flip(reef.remember(valid))
        expect(error).toMatchObject({ _tag: "EmbedError", reason: "shape" })
      }).pipe(Effect.provide(reefStack(wrong)))
    },
  )
})

describe("what the Reef hands out", () => {
  it.effect("search and history rows carry no embedding", () =>
    Effect.gen(function* () {
      const reef = yield* Reef
      const v1 = yield* reef.remember({ ...BOT_A, kind: "semantic", content: "plain words", source: "t" })
      const v2 = yield* reef.supersede(v1.id, { kind: "semantic", content: "plain words again", source: "t" })
      const hits = yield* reef.search("plain", { scopes: [BOT_A] })
      expect(hits).toHaveLength(1)
      expect(hits.every((h) => !("embedding" in h))).toBe(true)
      const chain = yield* reef.history(v2.id)
      expect(chain).toHaveLength(2)
      expect(chain.every((m) => !("embedding" in m))).toBe(true)
      expect("embedding" in v2).toBe(false)
    }).pipe(Effect.provide(reefStack())),
  )
})

describe("atomicity with the Beacon", () => {
  const failingAppend = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      setFailAppend(true)
      return Effect.exit(effect)
    }).pipe(Effect.ensuring(Effect.sync(() => setFailAppend(false))))

  it.effect("remember leaves no row when the event cannot be appended", () =>
    Effect.gen(function* () {
      const reef = yield* Reef
      const sql = yield* SqlClient
      const exit = yield* failingAppend(
        reef.remember({ ...BOT_A, kind: "semantic", content: "ghost", source: "t" }),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* sql`SELECT count(*) AS n FROM memory_items`).toEqual([{ n: 0 }])
      expect(yield* sql`SELECT count(*) AS n FROM memory_fts WHERE memory_fts MATCH 'ghost'`).toEqual([
        { n: 0 },
      ])
    }).pipe(Effect.provide(reefStack())),
  )

  it.effect("supersede leaves the old item live and adds no successor when the event fails", () =>
    Effect.gen(function* () {
      const reef = yield* Reef
      const sql = yield* SqlClient
      const v1 = yield* reef.remember({ ...BOT_A, kind: "semantic", content: "stable fact", source: "t" })
      const exit = yield* failingAppend(
        reef.supersede(v1.id, { kind: "semantic", content: "changed fact", source: "t" }),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* sql`SELECT count(*) AS n FROM memory_items`).toEqual([{ n: 1 }])
      expect(yield* sql`SELECT superseded_by FROM memory_items WHERE id = ${v1.id}`).toEqual([
        { superseded_by: null },
      ])
      expect((yield* reef.search("stable", { scopes: [BOT_A] })).map((h) => h.id)).toEqual([v1.id])
    }).pipe(Effect.provide(reefStack())),
  )

  it.effect("forget leaves the item live when the event fails", () =>
    Effect.gen(function* () {
      const reef = yield* Reef
      const sql = yield* SqlClient
      const v1 = yield* reef.remember({ ...BOT_A, kind: "semantic", content: "keep me", source: "t" })
      const exit = yield* failingAppend(reef.forget(v1.id))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* sql`SELECT tombstone FROM memory_items WHERE id = ${v1.id}`).toEqual([{ tombstone: 0 }])
    }).pipe(Effect.provide(reefStack())),
  )
})

describe("semantic leg (no shared words with the query)", () => {
  // "zzz" is the query; every stored text is placed on axis 3 so only the vector can match.
  const placed = {
    zzz: axis(3),
    "alpha one": axis(3),
    "beta two": axis(3),
    "gamma old": axis(3),
    "delta new": axis(3),
  }
  const stack = reefStack(fixtureEmbedder(placed))

  it.effect("isolates scopes", () =>
    Effect.gen(function* () {
      const reef = yield* Reef
      const a = yield* reef.remember({ ...BOT_A, kind: "semantic", content: "alpha one", source: "t" })
      const b = yield* reef.remember({ ...BOT_B, kind: "semantic", content: "beta two", source: "t" })
      expect((yield* reef.search("zzz", { scopes: [BOT_A] })).map((h) => h.id)).toEqual([a.id])
      expect((yield* reef.search("zzz", { scopes: [BOT_B] })).map((h) => h.id)).toEqual([b.id])
      expect(yield* reef.search("zzz", { scopes: [GLOBAL] })).toEqual([])
    }).pipe(Effect.provide(stack)),
  )

  it.effect("hides a superseded item and a forgotten one", () =>
    Effect.gen(function* () {
      const reef = yield* Reef
      const old = yield* reef.remember({ ...BOT_A, kind: "semantic", content: "gamma old", source: "t" })
      const next = yield* reef.supersede(old.id, { kind: "semantic", content: "delta new", source: "t" })
      expect((yield* reef.search("zzz", { scopes: [BOT_A] })).map((h) => h.id)).toEqual([next.id])
      yield* reef.forget(next.id)
      expect(yield* reef.search("zzz", { scopes: [BOT_A] })).toEqual([])
    }).pipe(Effect.provide(stack)),
  )
})
