import { it } from "@effect/vitest"
import { BotId, NotFound } from "@shoalwork/contracts"
import type { MemoryItem, NewMemory } from "@shoalwork/reef"
import { EmbedError } from "@shoalwork/reef"
import { Effect, Schema } from "effect"
import { describe, expect } from "vitest"
import {
  forgetCallbackData,
  forgetCommand,
  MEMORY_CANCEL_DATA,
  type MemoryPort,
  memoryCallback,
  parseMemoryCallback,
  rememberCommand,
} from "../src/commands/memory.js"

const LEAD = Schema.decodeUnknownSync(BotId)("bot_00000000-0000-4000-8000-000000000001")
const OTHER = Schema.decodeUnknownSync(BotId)("bot_00000000-0000-4000-8000-000000000002")
const ID_A = "mem_00000000-0000-4000-8000-00000000000a"
const ID_B = "mem_00000000-0000-4000-8000-00000000000b"
const ID_C = "mem_00000000-0000-4000-8000-00000000000c"
const ID_OTHER = "mem_00000000-0000-4000-8000-0000000000d0"
const ID_GLOBAL = "mem_00000000-0000-4000-8000-0000000000e0"

const item = (overrides: Partial<MemoryItem> & Pick<MemoryItem, "id">): MemoryItem => ({
  scope: "bot",
  owner_id: LEAD,
  kind: "semantic",
  content: "Deploy usa Fly.io",
  source: "user:42",
  confidence: 1,
  created_at: "2026-10-20T10:00:00.000Z",
  superseded_by: null,
  tombstone: 0,
  ...overrides,
})

// In-memory stand-in for the Reef: the same four methods, with the calls recorded for assertions.
const fakeMemory = (seed: ReadonlyArray<MemoryItem>, options: { readonly embedderDown?: boolean } = {}) => {
  const items = new Map(seed.map((entry) => [entry.id, entry] as const))
  const remembered: Array<NewMemory> = []
  const forgotten: Array<string> = []
  const searches: Array<{ readonly q: string; readonly k: number | undefined; readonly scopes: unknown }> = []
  const port: MemoryPort = {
    remember: (next) =>
      options.embedderDown === true
        ? Effect.fail(new EmbedError({ reason: "timeout", detail: "slow" }))
        : Effect.sync(() => {
            remembered.push(next)
            return item({ id: `mem_new`, content: next.content, source: next.source })
          }),
    search: (q, opts) =>
      Effect.sync(() => {
        searches.push({ q, k: opts.k, scopes: opts.scopes })
        const scope = opts.scopes[0]
        return [...items.values()]
          .filter((entry) => entry.tombstone === 0 && entry.superseded_by === null)
          .filter(
            (entry) => scope !== undefined && entry.scope === scope.scope && entry.owner_id === scope.ownerId,
          )
          .filter((entry) => entry.content.toLowerCase().includes(q.toLowerCase()))
          .slice(0, opts.k ?? 8)
          .map((entry) => ({ ...entry, score: 1 }))
      }),
    forget: (id) =>
      Effect.gen(function* () {
        const entry = items.get(id)
        if (entry === undefined) {
          return yield* Effect.fail(new NotFound({ entity: "memory_item", id }))
        }
        items.set(id, { ...entry, tombstone: 1 })
        forgotten.push(id)
      }),
    history: (id) =>
      Effect.sync(() => {
        const entry = items.get(id)
        return entry === undefined ? [] : [entry]
      }),
  }
  return { port, remembered, forgotten, searches, items }
}

const TOPIC = { botId: LEAD, userId: "42" }

describe("parseMemoryCallback", () => {
  it("reads the data the /forget buttons carry and nothing else", () => {
    expect(parseMemoryCallback(forgetCallbackData(ID_A))).toEqual({ action: "forget", memoryId: ID_A })
    expect(parseMemoryCallback(MEMORY_CANCEL_DATA)).toEqual({ action: "cancel" })
    expect(parseMemoryCallback("mem:forget:abc")).toBeUndefined()
    expect(parseMemoryCallback("mem:cancel2")).toBeUndefined()
    expect(parseMemoryCallback("approve:x")).toBeUndefined()
  })

  it("keeps the forget callback data under Telegram's 64-byte limit", () => {
    expect(new TextEncoder().encode(forgetCallbackData(ID_A)).byteLength).toBeLessThanOrEqual(64)
  })
})

describe("/remember", () => {
  it.effect("stores a semantic memory of the topic's Bot with the sender as source and confirms", () => {
    const fake = fakeMemory([])
    return Effect.gen(function* () {
      const reply = yield* rememberCommand(fake.port, { ...TOPIC, text: "  Prefere respostas curtas  " })
      expect(reply).toEqual({ text: "Lembrado.", buttons: [] })
      expect(fake.remembered).toEqual([
        {
          scope: "bot",
          ownerId: LEAD,
          kind: "semantic",
          content: "Prefere respostas curtas",
          source: "user:42",
        },
      ])
    })
  })

  it.effect("does nothing outside a Bot topic", () => {
    const fake = fakeMemory([])
    return Effect.gen(function* () {
      const reply = yield* rememberCommand(fake.port, { botId: undefined, userId: "42", text: "algo" })
      expect(reply.text).toContain("tópico do Bot")
      expect(fake.remembered).toEqual([])
    })
  })

  it.effect("answers the usage line for empty text and writes nothing", () => {
    const fake = fakeMemory([])
    return Effect.gen(function* () {
      const reply = yield* rememberCommand(fake.port, { ...TOPIC, text: "   " })
      expect(reply.text).toBe("Uso: /remember <texto>")
      expect(fake.remembered).toEqual([])
    })
  })

  it.effect("answers a failure line when the embedder is down, without failing the command", () => {
    const fake = fakeMemory([], { embedderDown: true })
    return Effect.gen(function* () {
      const reply = yield* rememberCommand(fake.port, { ...TOPIC, text: "algo importante" })
      expect(reply.text).toContain("Não consegui gravar")
      expect(reply.buttons).toEqual([])
    })
  })
})

describe("/forget", () => {
  it.effect("searches only the topic's Bot scope with k=3 and offers numbered buttons plus cancel", () => {
    const fake = fakeMemory([
      item({ id: ID_A, content: "Deploy usa Fly.io" }),
      item({ id: ID_B, content: "Deploy roda na sexta" }),
      item({ id: ID_C, content: "Deploy precisa de aprovação" }),
      item({ id: ID_GLOBAL, scope: "global", owner_id: "global", content: "Deploy global" }),
    ])
    return Effect.gen(function* () {
      const reply = yield* forgetCommand(fake.port, { ...TOPIC, text: "deploy" })
      expect(fake.searches).toEqual([{ q: "deploy", k: 3, scopes: [{ scope: "bot", ownerId: LEAD }] }])
      expect(reply.text).toContain("1. Deploy")
      expect(reply.text).toContain("3. Deploy")
      expect(reply.text).not.toContain("Deploy global")
      expect(reply.buttons.map((button) => button.label)).toEqual(["1", "2", "3", "cancelar"])
      expect(reply.buttons.map((button) => button.data)).toEqual([
        forgetCallbackData(ID_A),
        forgetCallbackData(ID_B),
        forgetCallbackData(ID_C),
        MEMORY_CANCEL_DATA,
      ])
      expect(fake.forgotten).toEqual([])
    })
  })

  it.effect("answers without buttons when nothing matches", () => {
    const fake = fakeMemory([])
    return Effect.gen(function* () {
      const reply = yield* forgetCommand(fake.port, { ...TOPIC, text: "nada" })
      expect(reply).toEqual({ text: "Não encontrei nenhuma memória deste Bot sobre isso.", buttons: [] })
    })
  })

  it.effect("answers the usage line for empty text and does not search", () => {
    const fake = fakeMemory([])
    return Effect.gen(function* () {
      const reply = yield* forgetCommand(fake.port, { ...TOPIC, text: "" })
      expect(reply.text).toBe("Uso: /forget <texto>")
      expect(fake.searches).toEqual([])
    })
  })
})

describe("the /forget button", () => {
  const press = (port: MemoryPort, botId: typeof LEAD | undefined, data: string) => {
    const callback = parseMemoryCallback(data)
    return callback === undefined
      ? Effect.die(`not a memory callback: ${data}`)
      : memoryCallback(port, { botId, callback })
  }

  it.effect("forgets the item of the pressed button and only that item", () => {
    const fake = fakeMemory([
      item({ id: ID_A, content: "Deploy usa Fly.io" }),
      item({ id: ID_B, content: "Deploy roda na sexta" }),
      item({ id: ID_C, content: "Deploy precisa de aprovação" }),
    ])
    return Effect.gen(function* () {
      const listed = yield* forgetCommand(fake.port, { ...TOPIC, text: "deploy" })
      const secondButton = listed.buttons[1]
      expect(secondButton?.data).toBe(forgetCallbackData(ID_B))
      const reply = yield* press(fake.port, LEAD, secondButton?.data ?? "")
      expect(reply.text).toBe("Esquecida: Deploy roda na sexta")
      expect(fake.forgotten).toEqual([ID_B])
      expect(fake.items.get(ID_A)?.tombstone).toBe(0)
      expect(fake.items.get(ID_C)?.tombstone).toBe(0)
    })
  })

  it.effect("cancel forgets nothing", () => {
    const fake = fakeMemory([item({ id: ID_A })])
    return Effect.gen(function* () {
      const reply = yield* press(fake.port, LEAD, MEMORY_CANCEL_DATA)
      expect(reply.text).toBe("Cancelado. Nada foi esquecido.")
      expect(fake.forgotten).toEqual([])
    })
  })

  it.effect("refuses an item that belongs to another Bot or to the global memory", () => {
    const fake = fakeMemory([
      item({ id: ID_OTHER, owner_id: OTHER }),
      item({ id: ID_GLOBAL, scope: "global", owner_id: "global" }),
    ])
    return Effect.gen(function* () {
      const other = yield* press(fake.port, LEAD, forgetCallbackData(ID_OTHER))
      expect(other.text).toBe("Essa memória não pertence a este Bot.")
      const global = yield* press(fake.port, LEAD, forgetCallbackData(ID_GLOBAL))
      expect(global.text).toBe("Essa memória não pertence a este Bot.")
      expect(fake.forgotten).toEqual([])
    })
  })

  it.effect("answers that the item is gone for an unknown id", () => {
    const fake = fakeMemory([])
    return Effect.gen(function* () {
      const reply = yield* press(fake.port, LEAD, forgetCallbackData(ID_A))
      expect(reply.text).toBe("Essa memória não existe mais.")
      expect(fake.forgotten).toEqual([])
    })
  })

  it.effect("refuses an item that was already forgotten or superseded", () => {
    const fake = fakeMemory([item({ id: ID_A, tombstone: 1 }), item({ id: ID_B, superseded_by: ID_C })])
    return Effect.gen(function* () {
      const forgottenReply = yield* press(fake.port, LEAD, forgetCallbackData(ID_A))
      expect(forgottenReply.text).toBe("Essa memória já foi esquecida ou substituída.")
      const supersededReply = yield* press(fake.port, LEAD, forgetCallbackData(ID_B))
      expect(supersededReply.text).toBe("Essa memória já foi esquecida ou substituída.")
      expect(fake.forgotten).toEqual([])
    })
  })

  it.effect("does nothing when the callback arrives outside a Bot topic", () => {
    const fake = fakeMemory([item({ id: ID_A })])
    return Effect.gen(function* () {
      const reply = yield* press(fake.port, undefined, forgetCallbackData(ID_A))
      expect(reply.text).toContain("tópico do Bot")
      expect(fake.forgotten).toEqual([])
    })
  })
})
