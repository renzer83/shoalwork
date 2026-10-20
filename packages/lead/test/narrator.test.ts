import { it } from "@effect/vitest"
import { Beacon } from "@shoalwork/beacon"
import { Duration, Effect } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect } from "vitest"
import { startNarrator } from "../src/narrate.js"
import {
  ack,
  COALESCE_MS,
  commandPhrase,
  donePhrase,
  editPhrase,
  failedPhrase,
  langOf,
  mayNarrate,
  needsYouPhrase,
  redactSecrets,
  retryingPhrase,
  startedPhrase,
} from "../src/narrator.js"
import { TaskStore } from "../src/tasks.js"
import { createBots, harness, settle } from "./conversation-support.js"
import { Lead, specFor } from "./support.js"

describe("phrases", () => {
  it("speaks Portuguese by default and follows the detected language", () => {
    expect(startedPhrase()).toBe("Comecei.")
    expect(startedPhrase("en")).toBe("Started.")
    expect(ack("pt", "dev")).toBe("Entendi, passei para dev.")
    expect(ack("en", "dev")).toBe("Got it, handed it to dev.")
    expect(ack("es", "dev")).toBe("Entendido, se lo pasé a dev.")
    expect(retryingPhrase(2, "en")).toBe("Trying again (2/2)…")
    expect(donePhrase("all good", "en")).toBe("Done: all good")
    expect(failedPhrase("boom", "pt")).toBe("Falhou: boom")
    expect(needsYouPhrase("stuck", "en")).toBe("Needs you: stuck")
  })

  it("maps the Reflex language to a table, with Portuguese for 'other'", () => {
    expect([langOf("pt"), langOf("en"), langOf("es"), langOf("other"), langOf(undefined)]).toEqual([
      "pt",
      "en",
      "es",
      "pt",
      "pt",
    ])
  })

  it("names a test run, any other command and an edited file in one short line", () => {
    expect(commandPhrase("pnpm vitest run")).toBe("Rodando testes…")
    expect(commandPhrase("ls -la\n/some/where")).toBe("Rodando: ls -la /some/where")
    expect(commandPhrase(`echo ${"x".repeat(200)}`).length).toBeLessThan(80)
    expect(editPhrase("/work/repo/src/app.ts")).toBe("Editando app.ts…")
  })

  it("shows a summary on one line", () => {
    expect(donePhrase("line one\n\nline two")).toBe("Terminei: line one line two")
  })
})

describe("mayNarrate", () => {
  it("lets the first progress line through, then one per window, and never holds back an urgent one", () => {
    expect(mayNarrate(0, undefined, false)).toBe(true)
    expect(mayNarrate(1000, 0, false)).toBe(false)
    expect(mayNarrate(COALESCE_MS - 1, 0, false)).toBe(false)
    expect(mayNarrate(COALESCE_MS, 0, false)).toBe(true)
    expect(mayNarrate(1, 0, true)).toBe(true)
  })
})

const commandEvent = (bot: { readonly id: string }, taskId: string, cmd: string) => ({
  streamId: `task:${taskId}`,
  type: "executor.event" as const,
  payload: { taskId, botId: bot.id, event: { kind: "command", cmd } },
  actor: "system:lead",
  correlationId: taskId,
})

const start = (
  h: ReturnType<typeof harness>,
  summarize: (s: string) => Effect.Effect<string> = Effect.succeed,
) =>
  Effect.gen(function* () {
    yield* startNarrator({
      beacon: yield* Beacon,
      tasks: yield* TaskStore,
      telegram: h.telegram.shape,
      languageOf: () => "pt",
      forget: () => undefined,
      summarize,
    })
  })

describe("narrator (redaction and routing)", () => {
  it("replaces lines that name a secret or hold a credential, before they reach Telegram", () => {
    expect(commandPhrase("export TOKEN=abc123 && ls")).toBe("Rodando: [redacted]")
    expect(commandPhrase("curl -H x sk-live_abcdefgh12345")).toBe("Rodando: [redacted]")
    expect(commandPhrase("git clone https://user:pw@github.com/a/b")).toBe(
      "Rodando: git clone https://***@github.com/a/b",
    )
    expect(failedPhrase("login failed\nAPI_KEY=zzz")).toBe("Falhou: login failed [redacted]")
    expect(donePhrase(["gh", "p_", "a".repeat(36)].join(""))).toBe("Terminei: [redacted]")
    expect(needsYouPhrase("password rejected")).toBe("Precisa de você: [redacted]")
    expect(redactSecrets("ordinary line")).toBe("ordinary line")
  })

  it.effect("sends a task from another origin only its start and its end", () => {
    const h = harness()
    return Effect.gen(function* () {
      const { dev } = yield* createBots
      const beacon = yield* Beacon
      const lead = yield* Lead
      yield* start(h)
      const spec = yield* lead.intake(specFor(dev, { origin: "api" }))
      yield* beacon.append(commandEvent(dev, spec.id, "pnpm build"))
      yield* beacon.append({
        streamId: `task:${spec.id}`,
        type: "executor.started",
        payload: { taskId: spec.id, botId: dev.id, executor: "claude-code", model: "m", cwd: "/w" },
        actor: "system:lead",
        correlationId: spec.id,
      })
      yield* settle
      expect(h.telegram.sent.map((message) => message.text)).toEqual(["Comecei."])
    }).pipe(Effect.provide(h.layer))
  })

  it.effect("narrates cancellation and an exhausted budget in the topic of each task's own Bot", () => {
    const h = harness()
    return Effect.gen(function* () {
      const { lead: leadBot, dev } = yield* createBots
      const beacon = yield* Beacon
      const lead = yield* Lead
      yield* start(h)
      const a = yield* lead.intake(specFor(dev, { origin: "telegram" }))
      const b = yield* lead.intake(specFor(leadBot, { origin: "telegram" }))
      yield* beacon.append({
        streamId: `task:${a.id}`,
        type: "task.state_changed",
        payload: { taskId: a.id, from: "running", to: "cancelled" },
        actor: "system:lead",
        correlationId: a.id,
      })
      yield* beacon.append({
        streamId: `task:${b.id}`,
        type: "budget.exceeded",
        payload: {
          scope: "task",
          refId: b.id,
          limit: { tokens: 1, seconds: 1, usd: 1 },
          used: { tokens: 2, seconds: 2, usd: 2 },
        },
        actor: "system:lead",
        correlationId: b.id,
      })
      yield* settle
      expect(h.telegram.sent).toEqual([
        { botId: dev.id, text: "Cancelado." },
        { botId: leadBot.id, text: "Estourou o orçamento da tarefa; parei." },
      ])
    }).pipe(Effect.provide(h.layer))
  })

  it.effect("does not let a slow summary hold back the messages of other tasks", () => {
    const h = harness({ leadEvents: [{ kind: "done", result: "word ".repeat(100), artifacts: [] }] })
    return Effect.gen(function* () {
      const { dev } = yield* createBots
      const beacon = yield* Beacon
      const lead = yield* Lead
      yield* start(h, () => Effect.sleep(Duration.seconds(30)).pipe(Effect.as("resumo")))
      const slow = yield* lead.intake(specFor(dev, { origin: "telegram" }))
      yield* lead.runOnce(slow.id)
      yield* settle
      const other = yield* lead.intake(specFor(dev, { origin: "telegram" }))
      yield* beacon.append(commandEvent(dev, other.id, "pnpm test"))
      yield* settle
      expect(h.telegram.sent.map((message) => message.text)).toEqual(["Comecei.", "Rodando testes…"])
      yield* TestClock.adjust(Duration.seconds(30))
      yield* settle
      expect(h.telegram.sent.at(-1)?.text).toBe("Terminei: resumo")
    }).pipe(Effect.provide(h.layer))
  })
})

describe("narrator (events to messages)", () => {
  it.effect("announces the retry and, when it fails too, that Renan is needed", () => {
    const h = harness({
      leadEvents: [
        { kind: "started" },
        { kind: "error", code: "max_turns", message: "reached the turn limit" },
      ],
    })
    return Effect.gen(function* () {
      const { dev } = yield* createBots
      const beacon = yield* Beacon
      const tasks = yield* TaskStore
      const lead = yield* Lead
      yield* startNarrator({
        beacon,
        tasks,
        telegram: h.telegram.shape,
        languageOf: () => "pt",
        forget: () => undefined,
        summarize: (summary) => Effect.succeed(summary),
      })
      const spec = yield* lead.intake(specFor(dev, { origin: "telegram" }))
      yield* lead.runOnce(spec.id)
      yield* settle
      const texts = h.telegram.sent.map((message) => message.text)
      expect(texts.slice(0, 2)).toEqual(["Comecei.", "Tentando de novo (2/2)…"])
      expect(texts[2]?.startsWith("Precisa de você: ")).toBe(true)
      expect(texts).toHaveLength(3)
    }).pipe(Effect.provide(h.layer))
  })

  it.effect("coalesces five progress events in 20 s into one message", () => {
    const h = harness()
    return Effect.gen(function* () {
      const { dev } = yield* createBots
      const beacon = yield* Beacon
      const tasks = yield* TaskStore
      yield* startNarrator({
        beacon,
        tasks,
        telegram: h.telegram.shape,
        languageOf: () => "pt",
        forget: () => undefined,
        summarize: (summary) => Effect.succeed(summary),
      })
      const lead = yield* Lead
      const taskId = (yield* lead.intake(specFor(dev, { origin: "telegram" }))).id
      for (const cmd of ["ls", "pnpm test", "cat a", "cat b", "git status"]) {
        yield* beacon.append(commandEvent(dev, taskId, cmd))
        yield* TestClock.adjust(Duration.seconds(3))
        yield* settle
      }
      expect(h.telegram.sent.map((message) => message.text)).toEqual(["Rodando: ls"])
      yield* TestClock.adjust(Duration.seconds(10))
      yield* beacon.append(commandEvent(dev, taskId, "pnpm test"))
      yield* settle
      expect(h.telegram.sent.map((message) => message.text)).toEqual(["Rodando: ls", "Rodando testes…"])
    }).pipe(Effect.provide(h.layer))
  })

  it.effect("uses the language the task was asked in", () => {
    const h = harness()
    return Effect.gen(function* () {
      const { dev } = yield* createBots
      const beacon = yield* Beacon
      const tasks = yield* TaskStore
      yield* startNarrator({
        beacon,
        tasks,
        telegram: h.telegram.shape,
        languageOf: () => "en",
        forget: () => undefined,
        summarize: (summary) => Effect.succeed(summary),
      })
      const lead = yield* Lead
      const spec = yield* lead.intake(specFor(dev, { origin: "telegram" }))
      yield* beacon.append(commandEvent(dev, spec.id, "pnpm test"))
      yield* settle
      expect(h.telegram.sent.map((message) => message.text)).toEqual(["Running tests…"])
    }).pipe(Effect.provide(h.layer))
  })

  it.effect("narrates a whole task: started, then done with the summary, in the Bot's topic", () => {
    const h = harness()
    return Effect.gen(function* () {
      const { dev } = yield* createBots
      const beacon = yield* Beacon
      const tasks = yield* TaskStore
      const lead = yield* Lead
      yield* startNarrator({
        beacon,
        tasks,
        telegram: h.telegram.shape,
        languageOf: () => "pt",
        forget: () => undefined,
        summarize: (summary) => Effect.succeed(summary),
      })
      const spec = yield* lead.intake(specFor(dev))
      yield* lead.runOnce(spec.id)
      yield* settle
      expect(h.telegram.sent).toEqual([
        { botId: dev.id, text: "Comecei." },
        { botId: dev.id, text: "Terminei: all good" },
      ])
    }).pipe(Effect.provide(h.layer))
  })

  it.effect("summarises a long summary with the chat tier before showing it", () => {
    const h = harness({ leadEvents: [{ kind: "done", result: "word ".repeat(100), artifacts: [] }] })
    const seen: Array<string> = []
    return Effect.gen(function* () {
      const { dev } = yield* createBots
      const beacon = yield* Beacon
      const tasks = yield* TaskStore
      const lead = yield* Lead
      yield* startNarrator({
        beacon,
        tasks,
        telegram: h.telegram.shape,
        languageOf: () => "pt",
        forget: () => undefined,
        summarize: (summary) => {
          seen.push(summary)
          return Effect.succeed("resumo curto")
        },
      })
      const spec = yield* lead.intake(specFor(dev))
      yield* lead.runOnce(spec.id)
      yield* settle
      expect(h.telegram.sent.at(-1)?.text).toBe("Terminei: resumo curto")
      expect(seen[0]?.length).toBeGreaterThan(300)
    }).pipe(Effect.provide(h.layer))
  })
})
