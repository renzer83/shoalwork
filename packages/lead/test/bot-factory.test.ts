import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { Beacon, BeaconLive } from "@shoalwork/beacon"
import { BotRegistry, BotRegistryLive, loadBotFile } from "@shoalwork/bots"
import { type BotId, NewBot } from "@shoalwork/contracts"
import type { MessageRef, SendFlags, TelegramOutShape } from "@shoalwork/currents"
import { withTempDb } from "@shoalwork/db/testing"
import { Duration, Effect, Layer, Schema, Stream } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import {
  type BotFactoryConfig,
  type BotFactoryDeps,
  handleConfirmBot,
  isCreateBotRequest,
  parseConfirmBot,
  proposeBot,
} from "../src/bot-factory.js"
import { checkProposal } from "../src/bot-proposal.js"
import { ChatFailure } from "../src/chat.js"

// Real SQLite per test (migrations applied), with the registry and the Beacon it writes to.
const TestLayer = Layer.provideMerge(BotRegistryLive, Layer.provideMerge(BeaconLive, withTempDb()))

const EXECUTORS = ["claude-code", "codex"]
const CONFIG: BotFactoryConfig = {
  ceiling: { tokens: 500_000, seconds: 1800, usd: 5 },
  policy: "default",
  tank: { mode: "local", host: "mac" },
}
const RENAN = "42"
const STRANGER = "999"

const LEAD = Schema.decodeUnknownSync(NewBot)({
  name: "lead",
  role: "coordinator",
  kind: "fixed",
  instructions: "You are the Lead.",
  executors: { preferred: "claude-code", allowed: ["claude-code"] },
  modelTiers: {},
  connectors: [],
  budget: { tokens: 2_000_000, seconds: 14_400, usd: 20 },
  policy: "default",
  tank: { mode: "local", host: "mac" },
  memory: { scope: "global" },
})

// A definition the checks accept, wrapped in prose and a fence the way a model often answers.
const goodDraft = (over: Readonly<Record<string, unknown>> = {}): Record<string, unknown> => ({
  name: "marketing-faturium",
  role: "marketing",
  instructions:
    "Write short campaigns for Faturium.\nKeep every message under 300 characters.\nNever promise discounts.\nAsk before publishing.",
  executors: { preferred: "claude-code", allowed: ["claude-code"] },
  budget: { tokens: 300_000, seconds: 900, usd: 2 },
  ...over,
})
const asReply = (draft: Record<string, unknown>): string =>
  `Aqui está a ficha:\n\`\`\`json\n${JSON.stringify(draft)}\n\`\`\``

interface FakeTelegram {
  readonly shape: TelegramOutShape
  readonly sent: Array<{
    readonly botId: BotId
    readonly text: string
    readonly flags: SendFlags | undefined
  }>
  readonly topics: Array<string>
  // Every keyboard edit: the message and what it was set to (null removes the buttons).
  readonly edits: Array<{ readonly ref: MessageRef; readonly markup: unknown }>
}

const fakeTelegram = (): FakeTelegram => {
  const sent: FakeTelegram["sent"] = []
  const topics: Array<string> = []
  const edits: FakeTelegram["edits"] = []
  const shape: TelegramOutShape = {
    send: (botId, text, flags) =>
      Effect.sync(() => {
        sent.push({ botId, text, flags })
      }),
    // The message reference is the position in the sent list, so the test can tell which proposal was edited.
    sendRef: (botId, text, flags) =>
      Effect.sync(() => {
        sent.push({ botId, text, flags })
        return { chatId: "-100", messageId: sent.length }
      }),
    editReplyMarkup: (ref, markup) =>
      Effect.sync(() => {
        edits.push({ ref, markup })
      }),
    typing: () => Effect.sync(() => undefined),
    ensureTopic: (bot) =>
      Effect.sync(() => {
        topics.push(bot.name)
        return { chatId: "-100", threadId: topics.length }
      }),
  }
  return { shape, sent, topics, edits }
}

// The model: replies in order (the last one repeats), and every prompt it was given.
const modelReplying = (...replies: ReadonlyArray<string>) => {
  const prompts: Array<string> = []
  let calls = 0
  const ask = (prompt: string): Effect.Effect<string, ChatFailure> =>
    Effect.sync(() => {
      prompts.push(prompt)
      const reply = replies[Math.min(calls, replies.length - 1)] ?? ""
      calls += 1
      return reply
    })
  return { ask, prompts }
}

// A temporary bots/ directory per test; removed when the test ends.
const withDir = <A, E, R>(body: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "bot-factory-"))),
    body,
    (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  )

const scenario = <A, E>(body: (dir: string) => Effect.Effect<A, E, SqlClient | BotRegistry | Beacon>) =>
  withDir(body).pipe(Effect.provide(TestLayer))

const setup = (
  dir: string,
  ask: BotFactoryDeps["ask"],
  telegram: FakeTelegram,
  config: Partial<BotFactoryConfig> = {},
  botsDir: string = dir,
) =>
  Effect.gen(function* () {
    const registry = yield* BotRegistry
    const lead = yield* registry.upsert(LEAD, "test")
    const deps: BotFactoryDeps = {
      sql: yield* SqlClient,
      bots: registry,
      telegram: telegram.shape,
      ask,
      botsDir,
      executors: EXECUTORS,
      config: { ...CONFIG, ...config },
    }
    return { deps, lead, registry }
  })

const proposalRow = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const rows = yield* sql<{
      readonly status: string
      readonly requested_by: string
      readonly created_at: string
      readonly expires_at: string
    }>`SELECT status, requested_by, created_at, expires_at FROM bot_proposals WHERE id = ${id}`
    return rows[0]
  })

const createdEvents = Effect.gen(function* () {
  const beacon = yield* Beacon
  return Array.from(yield* Stream.runCollect(beacon.readAll(0, ["bot.created"])))
})

// The proposal id is the last token of the button data: botprop:ok:<id>.
const buttonsOf = (flags: SendFlags | undefined): ReadonlyArray<string> =>
  (flags?.replyMarkup?.inline_keyboard[0] ?? []).flatMap((button) =>
    "callback_data" in button ? [button.callback_data] : [],
  )

const proposedId = (outcome: { readonly kind: string; readonly proposalId?: string }): string => {
  if (outcome.kind !== "proposed" || outcome.proposalId === undefined) {
    throw new Error(`expected a proposal, got ${outcome.kind}`)
  }
  return outcome.proposalId
}

describe("isCreateBotRequest and parseConfirmBot", () => {
  it("recognises a request to create a bot, in Portuguese or English", () => {
    expect(isCreateBotRequest("cria um bot de marketing para o Faturium")).toBe(true)
    expect(isCreateBotRequest("criar bot de suporte")).toBe(true)
    expect(isCreateBotRequest("create a bot for research")).toBe(true)
    expect(isCreateBotRequest("oi, tudo bem?")).toBe(false)
    expect(isCreateBotRequest("qual é o bot do financeiro")).toBe(false)
  })

  it("reads confirm and cancel commands and rejects anything else", () => {
    const id = "prop_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
    expect(parseConfirmBot(`/confirm-bot ${id} ok`)).toEqual({ proposalId: id, decision: "ok" })
    expect(parseConfirmBot(`/confirm-bot ${id} no`)).toEqual({ proposalId: id, decision: "no" })
    expect(parseConfirmBot(`/confirm-bot ${id} maybe`)).toBeUndefined()
    expect(parseConfirmBot("/confirm-bot prop_x ok")).toBeUndefined()
    expect(parseConfirmBot(`/confirm-bot ${id} ok extra`)).toBeUndefined()
  })
})

describe("checkProposal", () => {
  it.effect("accepts a definition wrapped in prose and fills the fixed fields", () =>
    Effect.gen(function* () {
      const bot = yield* checkProposal(asReply(goodDraft()), { executors: EXECUTORS, rules: CONFIG })
      expect(bot).toMatchObject({
        name: "marketing-faturium",
        kind: "auxiliary",
        connectors: [],
        modelTiers: {},
        policy: "default",
        tank: { mode: "local", host: "mac" },
        memory: { scope: "bot" },
      })
    }),
  )
})

describe("proposeBot", () => {
  it.effect("stores a pending proposal and sends it with Confirmar and Cancelar buttons", () =>
    scenario((dir) =>
      Effect.gen(function* () {
        const telegram = fakeTelegram()
        const model = modelReplying(asReply(goodDraft()))
        const { deps, lead } = yield* setup(dir, model.ask, telegram)
        const outcome = yield* proposeBot(deps, {
          botId: lead.id,
          requestedBy: RENAN,
          text: "cria um bot de marketing",
        })
        const id = proposedId(outcome)
        expect(id).toMatch(/^prop_/)
        expect(telegram.sent).toHaveLength(1)
        expect(telegram.sent[0]?.text).toContain("Nome: <code>marketing-faturium</code>")
        expect(buttonsOf(telegram.sent[0]?.flags)).toEqual([`botprop:ok:${id}`, `botprop:no:${id}`])
        const row = yield* proposalRow(id)
        expect(row?.status).toBe("pending")
        expect(row?.requested_by).toBe(RENAN)
        expect(readdirSync(dir)).toEqual([])
      }),
    ),
  )

  it.effect("expires a proposal one hour after it was made by default", () =>
    scenario((dir) =>
      Effect.gen(function* () {
        const telegram = fakeTelegram()
        const { deps, lead } = yield* setup(dir, modelReplying(asReply(goodDraft())).ask, telegram)
        const id = proposedId(
          yield* proposeBot(deps, { botId: lead.id, requestedBy: RENAN, text: "cria um bot" }),
        )
        const row = yield* proposalRow(id)
        expect(Date.parse(row?.expires_at ?? "") - Date.parse(row?.created_at ?? "")).toBe(60 * 60 * 1000)
      }),
    ),
  )

  it.effect("asks the model once more with the reason when the first answer is refused", () =>
    scenario((dir) =>
      Effect.gen(function* () {
        const telegram = fakeTelegram()
        const model = modelReplying("não sei fazer isso", asReply(goodDraft()))
        const { deps, lead } = yield* setup(dir, model.ask, telegram)
        const outcome = yield* proposeBot(deps, { botId: lead.id, requestedBy: RENAN, text: "cria um bot" })
        expect(outcome.kind).toBe("proposed")
        expect(model.prompts).toHaveLength(2)
        expect(model.prompts[1]).toContain(
          "Your previous answer was rejected: the reply is not a JSON bot definition",
        )
      }),
    ),
  )

  it.effect("gives up after a second refusal: no proposal, one 'não consegui' reply", () =>
    scenario((dir) =>
      Effect.gen(function* () {
        const telegram = fakeTelegram()
        const model = modelReplying("x", "y")
        const { deps, lead } = yield* setup(dir, model.ask, telegram)
        const outcome = yield* proposeBot(deps, { botId: lead.id, requestedBy: RENAN, text: "cria um bot" })
        expect(outcome.kind).toBe("invalid")
        expect(telegram.sent).toHaveLength(1)
        expect(telegram.sent[0]?.text).toContain("Não consegui montar a ficha")
        const sql = yield* SqlClient
        expect(yield* sql<{ readonly id: string }>`SELECT id FROM bot_proposals`).toHaveLength(0)
      }),
    ),
  )

  it.effect("treats a model that gives no answer as a refusal", () =>
    scenario((dir) =>
      Effect.gen(function* () {
        const telegram = fakeTelegram()
        const failing = (): Effect.Effect<string, ChatFailure> =>
          Effect.fail(new ChatFailure({ reason: "error", message: "down" }))
        const { deps, lead } = yield* setup(dir, failing, telegram)
        const outcome = yield* proposeBot(deps, { botId: lead.id, requestedBy: RENAN, text: "cria um bot" })
        expect(outcome.kind).toBe("invalid")
      }),
    ),
  )

  // Each refusal is a definition the checks must not let through.
  const refused: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["a name with spaces and capitals", goodDraft({ name: "Marketing Faturium" })],
    ["a name that would escape bots/", goodDraft({ name: "../escape" })],
    ["a name too short", goodDraft({ name: "x" })],
    [
      "an executor that is not installed",
      goodDraft({ executors: { preferred: "gemini", allowed: ["gemini"] } }),
    ],
    [
      "a preferred executor outside allowed",
      goodDraft({ executors: { preferred: "codex", allowed: ["claude-code"] } }),
    ],
    ["a budget above the ceiling", goodDraft({ budget: { tokens: 300_000, seconds: 900, usd: 50 } })],
    ["a zero budget", goodDraft({ budget: { tokens: 0, seconds: 900, usd: 2 } })],
    ["a policy that is not the configured one", goodDraft({ policy: "allow-all" })],
    ["a tank that is not the configured one", goodDraft({ tank: { mode: "server", host: "box" } })],
    ["a role outside the list", goodDraft({ role: "boss" })],
    ["empty instructions", goodDraft({ instructions: "   " })],
  ]
  for (const [label, draft] of refused) {
    it.effect(`refuses ${label} and records nothing`, () =>
      scenario((dir) =>
        Effect.gen(function* () {
          const telegram = fakeTelegram()
          const { deps, lead } = yield* setup(dir, modelReplying(asReply(draft)).ask, telegram)
          const outcome = yield* proposeBot(deps, { botId: lead.id, requestedBy: RENAN, text: "cria um bot" })
          expect(outcome.kind).toBe("invalid")
          const sql = yield* SqlClient
          expect(yield* sql<{ readonly id: string }>`SELECT id FROM bot_proposals`).toHaveLength(0)
          expect(readdirSync(dir)).toEqual([])
        }),
      ),
    )
  }

  it.effect("accepts the policy and tank only when they are the configured ones", () =>
    scenario((dir) =>
      Effect.gen(function* () {
        const telegram = fakeTelegram()
        const draft = goodDraft({ policy: "default", tank: { mode: "local", host: "mac" } })
        const { deps, lead } = yield* setup(dir, modelReplying(asReply(draft)).ask, telegram)
        const outcome = yield* proposeBot(deps, { botId: lead.id, requestedBy: RENAN, text: "cria um bot" })
        expect(outcome.kind).toBe("proposed")
      }),
    ),
  )
})

describe("handleConfirmBot", () => {
  it.effect("writes bots/<name>.yaml that loads, registers the Bot and answers in its topic", () =>
    scenario((dir) =>
      Effect.gen(function* () {
        const telegram = fakeTelegram()
        const { deps, lead, registry } = yield* setup(dir, modelReplying(asReply(goodDraft())).ask, telegram)
        const id = proposedId(
          yield* proposeBot(deps, { botId: lead.id, requestedBy: RENAN, text: "cria um bot" }),
        )
        const outcome = yield* handleConfirmBot(deps, {
          replyTo: lead.id,
          proposalId: id,
          decision: "ok",
          userId: RENAN,
        })
        expect(outcome).toMatchObject({
          kind: "created",
          name: "marketing-faturium",
          botName: "marketing-faturium",
          status: "confirmed",
        })
        const loaded = yield* loadBotFile(join(dir, "marketing-faturium.yaml"))
        expect(loaded.name).toBe("marketing-faturium")
        expect(loaded.budget).toEqual({ tokens: 300_000, seconds: 900, usd: 2 })
        expect((yield* registry.getByName("marketing-faturium")).name).toBe("marketing-faturium")
        const events = yield* createdEvents
        expect(events.map((event) => event.payload)).toEqual(
          expect.arrayContaining([expect.objectContaining({ by: `user:${RENAN}` })]),
        )
        expect(telegram.topics).toEqual(["marketing-faturium"])
        expect(telegram.sent.at(-1)?.text).toBe("pronto, fala com ele em #marketing-faturium")
        expect(yield* proposalRowStatus(id)).toBe("confirmed")
      }),
    ),
  )

  it.effect("cancel records nothing on disk or in the registry", () =>
    scenario((dir) =>
      Effect.gen(function* () {
        const telegram = fakeTelegram()
        const { deps, lead, registry } = yield* setup(dir, modelReplying(asReply(goodDraft())).ask, telegram)
        const id = proposedId(
          yield* proposeBot(deps, { botId: lead.id, requestedBy: RENAN, text: "cria um bot" }),
        )
        const outcome = yield* handleConfirmBot(deps, {
          replyTo: lead.id,
          proposalId: id,
          decision: "no",
          userId: RENAN,
        })
        expect(outcome.kind).toBe("cancelled")
        expect(telegram.edits).toEqual([{ ref: { chatId: "-100", messageId: 1 }, markup: null }])
        expect(readdirSync(dir)).toEqual([])
        expect(yield* Effect.flip(registry.getByName("marketing-faturium"))).toMatchObject({
          _tag: "NotFound",
        })
        expect(yield* proposalRowStatus(id)).toBe("cancelled")
      }),
    ),
  )

  it.effect("refuses a decision from anyone but the user who asked, and keeps the proposal open", () =>
    scenario((dir) =>
      Effect.gen(function* () {
        const telegram = fakeTelegram()
        const { deps, lead } = yield* setup(dir, modelReplying(asReply(goodDraft())).ask, telegram)
        const id = proposedId(
          yield* proposeBot(deps, { botId: lead.id, requestedBy: RENAN, text: "cria um bot" }),
        )
        const other = yield* handleConfirmBot(deps, {
          replyTo: lead.id,
          proposalId: id,
          decision: "ok",
          userId: STRANGER,
        })
        expect(other.kind).toBe("not_yours")
        expect(yield* proposalRowStatus(id)).toBe("pending")
        expect(readdirSync(dir)).toEqual([])
        const mine = yield* handleConfirmBot(deps, {
          replyTo: lead.id,
          proposalId: id,
          decision: "ok",
          userId: RENAN,
        })
        expect(mine.kind).toBe("created")
      }),
    ),
  )

  it.effect("decides once: a second confirmation creates nothing more", () =>
    scenario((dir) =>
      Effect.gen(function* () {
        const telegram = fakeTelegram()
        const { deps, lead } = yield* setup(dir, modelReplying(asReply(goodDraft())).ask, telegram)
        const id = proposedId(
          yield* proposeBot(deps, { botId: lead.id, requestedBy: RENAN, text: "cria um bot" }),
        )
        yield* handleConfirmBot(deps, { replyTo: lead.id, proposalId: id, decision: "ok", userId: RENAN })
        const again = yield* handleConfirmBot(deps, {
          replyTo: lead.id,
          proposalId: id,
          decision: "ok",
          userId: RENAN,
        })
        expect(again.kind).toBe("already_decided")
        const cancel = yield* handleConfirmBot(deps, {
          replyTo: lead.id,
          proposalId: id,
          decision: "no",
          userId: RENAN,
        })
        expect(cancel.kind).toBe("already_decided")
        expect(readdirSync(dir)).toEqual(["marketing-faturium.yaml"])
        const byRenan = (yield* createdEvents).filter((event) =>
          Schema.is(Schema.Struct({ by: Schema.Literal(`user:${RENAN}`) }))(event.payload),
        )
        expect(byRenan).toHaveLength(1)
      }),
    ),
  )

  it.effect("a name taken in the registry gets the suffix -2 and the reply says so", () =>
    scenario((dir) =>
      Effect.gen(function* () {
        const telegram = fakeTelegram()
        const { deps, lead, registry } = yield* setup(dir, modelReplying(asReply(goodDraft())).ask, telegram)
        yield* registry.upsert(
          Schema.decodeUnknownSync(NewBot)({
            ...goodDraft(),
            kind: "auxiliary",
            modelTiers: {},
            connectors: [],
            policy: "default",
            tank: { mode: "local", host: "mac" },
            memory: { scope: "bot" },
          }),
          "test",
        )
        const id = proposedId(
          yield* proposeBot(deps, { botId: lead.id, requestedBy: RENAN, text: "cria um bot" }),
        )
        const outcome = yield* handleConfirmBot(deps, {
          replyTo: lead.id,
          proposalId: id,
          decision: "ok",
          userId: RENAN,
        })
        expect(outcome).toMatchObject({
          kind: "created",
          name: "marketing-faturium-2",
          botName: "marketing-faturium-2",
          status: "confirmed",
        })
        expect(readdirSync(dir)).toEqual(["marketing-faturium-2.yaml"])
        expect(telegram.sent.at(-1)?.text).toContain("criei como marketing-faturium-2")
      }),
    ),
  )

  it.effect("a name whose file already exists in bots/ gets the suffix -2 and nothing is replaced", () =>
    scenario((dir) =>
      Effect.gen(function* () {
        const telegram = fakeTelegram()
        const { deps, lead } = yield* setup(dir, modelReplying(asReply(goodDraft())).ask, telegram)
        writeFileSync(join(dir, "marketing-faturium.yaml"), "name: keep-me\n")
        const id = proposedId(
          yield* proposeBot(deps, { botId: lead.id, requestedBy: RENAN, text: "cria um bot" }),
        )
        const outcome = yield* handleConfirmBot(deps, {
          replyTo: lead.id,
          proposalId: id,
          decision: "ok",
          userId: RENAN,
        })
        expect(outcome.kind).toBe("created")
        expect(outcome.name).toBe("marketing-faturium-2")
        expect(readFileSync(join(dir, "marketing-faturium.yaml"), "utf8")).toBe("name: keep-me\n")
      }),
    ),
  )

  it.effect("a file that cannot be written leaves the proposal failed and no Bot registered", () =>
    scenario((dir) =>
      Effect.gen(function* () {
        const telegram = fakeTelegram()
        const missing = join(dir, "missing")
        const { deps, lead, registry } = yield* setup(
          dir,
          modelReplying(asReply(goodDraft())).ask,
          telegram,
          {},
          missing,
        )
        const id = proposedId(
          yield* proposeBot(deps, { botId: lead.id, requestedBy: RENAN, text: "cria um bot" }),
        )
        const outcome = yield* handleConfirmBot(deps, {
          replyTo: lead.id,
          proposalId: id,
          decision: "ok",
          userId: RENAN,
        })
        expect(outcome.kind).toBe("failed")
        expect(yield* Effect.flip(registry.getByName("marketing-faturium"))).toMatchObject({
          _tag: "NotFound",
        })
        expect(yield* proposalRowStatus(id)).toBe("failed")
      }),
    ),
  )

  it.live("a proposal past its time to live expires and writes nothing", () =>
    scenario((dir) =>
      Effect.gen(function* () {
        const telegram = fakeTelegram()
        const { deps, lead, registry } = yield* setup(
          dir,
          modelReplying(asReply(goodDraft())).ask,
          telegram,
          { proposalTtlMs: 1 },
        )
        const id = proposedId(
          yield* proposeBot(deps, { botId: lead.id, requestedBy: RENAN, text: "cria um bot" }),
        )
        yield* Effect.sleep(Duration.millis(20))
        const outcome = yield* handleConfirmBot(deps, {
          replyTo: lead.id,
          proposalId: id,
          decision: "ok",
          userId: RENAN,
        })
        expect(outcome.kind).toBe("expired")
        expect(telegram.edits).toEqual([{ ref: { chatId: "-100", messageId: 1 }, markup: null }])
        expect(readdirSync(dir)).toEqual([])
        expect(yield* Effect.flip(registry.getByName("marketing-faturium"))).toMatchObject({
          _tag: "NotFound",
        })
        expect(yield* proposalRowStatus(id)).toBe("expired")
      }),
    ),
  )

  it.effect("an unknown or malformed proposal id is not found and changes nothing", () =>
    scenario((dir) =>
      Effect.gen(function* () {
        const telegram = fakeTelegram()
        const { deps, lead } = yield* setup(dir, modelReplying(asReply(goodDraft())).ask, telegram)
        const unknown = yield* handleConfirmBot(deps, {
          replyTo: lead.id,
          proposalId: "prop_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4e",
          decision: "ok",
          userId: RENAN,
        })
        const malformed = yield* handleConfirmBot(deps, {
          replyTo: lead.id,
          proposalId: "abc",
          decision: "ok",
          userId: RENAN,
        })
        expect(unknown.kind).toBe("not_found")
        expect(malformed.kind).toBe("not_found")
        expect(readdirSync(dir)).toEqual([])
      }),
    ),
  )
})

// The status of a proposal, read from the table the factory writes.
const proposalRowStatus = (id: string) =>
  Effect.gen(function* () {
    const row = yield* proposalRow(id)
    return row?.status
  })

describe("proposal message, buttons and executors", () => {
  it.effect("returns the proposal as proposalId, botName and status", () =>
    scenario((dir) =>
      Effect.gen(function* () {
        const telegram = fakeTelegram()
        const { deps, lead } = yield* setup(dir, modelReplying(asReply(goodDraft())).ask, telegram)
        const outcome = yield* proposeBot(deps, { botId: lead.id, requestedBy: RENAN, text: "cria um bot" })
        expect(outcome).toMatchObject({
          kind: "proposed",
          proposalId: expect.stringMatching(/^prop_/),
          botName: "marketing-faturium",
          status: "pending",
        })
      }),
    ),
  )

  it.effect("sends the proposal as HTML and escapes what the model wrote", () =>
    scenario((dir) =>
      Effect.gen(function* () {
        const telegram = fakeTelegram()
        const draft = goodDraft({ instructions: "Use <b>bold</b> & <script>alert(1)</script>" })
        const { deps, lead } = yield* setup(dir, modelReplying(asReply(draft)).ask, telegram)
        yield* proposeBot(deps, { botId: lead.id, requestedBy: RENAN, text: "cria um bot" })
        const sent = telegram.sent[0]
        expect(sent?.flags?.html).toBe(true)
        expect(sent?.text).toContain("<b>Proposta de Bot</b>")
        expect(sent?.text).toContain(
          "Use &lt;b&gt;bold&lt;/b&gt; &amp; &lt;script&gt;alert(1)&lt;/script&gt;",
        )
        expect(sent?.text).not.toContain("<script>")
      }),
    ),
  )

  it.effect("removes the proposal buttons once it is confirmed", () =>
    scenario((dir) =>
      Effect.gen(function* () {
        const telegram = fakeTelegram()
        const { deps, lead } = yield* setup(dir, modelReplying(asReply(goodDraft())).ask, telegram)
        const id = proposedId(
          yield* proposeBot(deps, { botId: lead.id, requestedBy: RENAN, text: "cria um bot" }),
        )
        yield* handleConfirmBot(deps, { replyTo: lead.id, proposalId: id, decision: "ok", userId: RENAN })
        expect(telegram.edits).toEqual([{ ref: { chatId: "-100", messageId: 1 }, markup: null }])
      }),
    ),
  )

  it.effect("keeps the buttons when the decision is refused", () =>
    scenario((dir) =>
      Effect.gen(function* () {
        const telegram = fakeTelegram()
        const { deps, lead } = yield* setup(dir, modelReplying(asReply(goodDraft())).ask, telegram)
        const id = proposedId(
          yield* proposeBot(deps, { botId: lead.id, requestedBy: RENAN, text: "cria um bot" }),
        )
        yield* handleConfirmBot(deps, { replyTo: lead.id, proposalId: id, decision: "no", userId: STRANGER })
        expect(telegram.edits).toEqual([])
      }),
    ),
  )

  it.effect("offers the model only the Bot executors: the chat executor is not listed and not accepted", () =>
    scenario((dir) =>
      Effect.gen(function* () {
        const telegram = fakeTelegram()
        const model = modelReplying(
          asReply(goodDraft({ executors: { preferred: "claude-code@chat", allowed: ["claude-code@chat"] } })),
        )
        const { deps, lead } = yield* setup(dir, model.ask, telegram, {}, dir)
        const withChatExecutors = { ...deps, executors: [...EXECUTORS, "claude-code@chat"] }
        const outcome = yield* proposeBot(withChatExecutors, {
          botId: lead.id,
          requestedBy: RENAN,
          text: "cria um bot",
        })
        expect(outcome.kind).toBe("invalid")
        expect(model.prompts[0]).toContain("Available executors: claude-code, codex")
        expect(model.prompts[0]).not.toContain("claude-code@chat")
      }),
    ),
  )
})
