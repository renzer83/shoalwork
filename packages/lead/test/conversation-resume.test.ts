import { it } from "@effect/vitest"
import {
  type BotId,
  newBotId,
  newEventId,
  newTaskId,
  type TaskId,
  type TaskSpec,
  type TaskState,
} from "@shoalwork/contracts"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { makeResumeAnswers } from "../src/conversation-resume.js"
import type { LeadShape } from "../src/lead.js"
import type { Lang } from "../src/narrator.js"
import type { ResumeRequest } from "../src/resume-request.js"
import type { TaskRecord, TaskStoreShape } from "../src/tasks.js"

const unused = () => Effect.die("not used by the resume answer")

// The Lead's record of a task it intook: the answer only reads the state, which a new task starts in.
const unusedGet =
  (created: ReadonlyArray<TaskSpec>): LeadShape["get"] =>
  (id) => {
    const spec = created.find((candidate) => candidate.id === id)
    return spec === undefined ? Effect.die("unknown task") : Effect.succeed({ spec, state: "received" })
  }

const recordOf = (botId: BotId, title: string, state: TaskState, resumeOf?: TaskId): TaskRecord => {
  const spec: TaskSpec = {
    id: newTaskId(),
    ...(resumeOf === undefined ? {} : { resumeOf }),
    botId,
    title,
    prompt: `${title}, please`,
    kind: "code",
    repo: { url: "https://github.com/renzer83/shoalwork-sandbox", base: "main" },
    acceptance: ["tests pass"],
    budget: { tokens: 1000, seconds: 60, usd: 1 },
    tier: "light",
    origin: "telegram",
  }
  return {
    spec,
    state,
    attempts: 1,
    createdAt: "2026-10-19T10:00:00.000Z",
    updatedAt: "2026-10-19T10:00:00.000Z",
  }
}

// A conversation answer with a fake task store (the Bot's tasks) and a fake Lead that records every intake.
const harness = (records: ReadonlyArray<TaskRecord>) => {
  const sent: Array<string> = []
  const intakes: Array<Parameters<LeadShape["intake"]>[0]> = []
  const created: Array<TaskSpec> = []
  const languages = new Map<TaskId, Lang>()
  const tasks: TaskStoreShape = {
    insert: unused,
    get: unused,
    update: unused,
    countRunning: unused,
    listByBot: (botId) => Effect.succeed(records.filter((record) => record.spec.botId === botId)),
  }
  const lead: LeadShape = {
    intake: (input) =>
      Effect.sync(() => {
        intakes.push(input)
        const spec: TaskSpec = { ...input, id: newTaskId(), tier: input.tier ?? "light" }
        created.push(spec)
        return spec
      }),
    get: unusedGet(created),
    runOnce: unused,
    runTask: unused,
    handoff: unused,
    abandon: unused,
    startWorker: unused,
  }
  const answer = makeResumeAnswers({
    tasks,
    lead,
    say: (_botId, text) =>
      Effect.sync(() => {
        sent.push(text)
      }),
    languages,
    channel: "telegram",
  })
  return { answer, sent, intakes, languages }
}

const event = { id: newEventId(), correlationId: "tg-42" }

describe("continuing a task in a Bot's topic", () => {
  it.effect("a finished task is continued as a new task of the same Bot that names it", () => {
    const bot = newBotId()
    const finished = recordOf(bot, "Refactor parser", "failed")
    const { answer, sent, intakes, languages } = harness([finished])
    const request: ResumeRequest = { kind: "title", title: "Refactor parser" }
    return Effect.gen(function* () {
      yield* answer(event, { id: bot }, request, "en")
      expect(intakes).toHaveLength(1)
      expect(intakes[0]).toMatchObject({
        botId: bot,
        title: "Refactor parser",
        prompt: finished.spec.prompt,
        repo: finished.spec.repo,
        acceptance: ["tests pass"],
        origin: "telegram",
        correlationId: "tg-42",
        resumeOf: finished.spec.id,
      })
      expect(languages.size).toBe(1)
      expect(sent).toHaveLength(1)
      expect(sent[0]).toMatch(/^Continuing "Refactor parser" as task task_/)
    })
  })

  it.effect("an ambiguous title lists the candidates with their ids and continues none", () => {
    const bot = newBotId()
    const first = recordOf(bot, "Deploy", "done")
    const second = recordOf(bot, "Deploy", "failed")
    const { answer, sent, intakes } = harness([first, second])
    return Effect.gen(function* () {
      yield* answer(event, { id: bot }, { kind: "title", title: "Deploy" }, "pt")
      expect(intakes).toHaveLength(0)
      expect(sent).toHaveLength(1)
      expect(sent[0]).toContain(`• ${first.spec.id} — Deploy (done)`)
      expect(sent[0]).toContain(`• ${second.spec.id} — Deploy (failed)`)
      expect(sent[0]).toContain("continua a task <id>")
    })
  })

  it.effect("a task still running is not continued", () => {
    const bot = newBotId()
    const going = recordOf(bot, "Deploy", "running")
    const { answer, sent, intakes } = harness([going])
    return Effect.gen(function* () {
      yield* answer(event, { id: bot }, { kind: "id", id: going.spec.id }, "pt")
      expect(intakes).toHaveLength(0)
      expect(sent[0]).toContain("ainda está em andamento")
      expect(sent[0]).toContain(going.spec.id)
    })
  })

  it.effect("a title of no task of this Bot is unknown here", () => {
    const { answer, sent, intakes } = harness([])
    return Effect.gen(function* () {
      yield* answer(event, { id: newBotId() }, { kind: "title", title: "Deploy" }, "es")
      expect(intakes).toHaveLength(0)
      expect(sent).toEqual(['Ninguna tarea de este Bot coincide con "Deploy".'])
    })
  })

  it.effect("a finished task is named by its id too, and an id of another Bot is unknown", () => {
    const bot = newBotId()
    const finished = recordOf(bot, "Deploy", "done")
    const { answer, sent, intakes } = harness([finished])
    const stranger: TaskId = newTaskId()
    return Effect.gen(function* () {
      yield* answer(event, { id: bot }, { kind: "id", id: stranger }, "pt")
      expect(intakes).toHaveLength(0)
      expect(sent[0]).toBe(`Nenhuma tarefa deste Bot corresponde a "${stranger}".`)
      yield* answer(event, { id: bot }, { kind: "id", id: finished.spec.id }, "pt")
      expect(intakes).toHaveLength(1)
    })
  })
  it.effect("a second continuation is answered with the id of the one under way, by id and by title", () => {
    const bot = newBotId()
    const parent = recordOf(bot, "Deploy", "failed")
    const running = recordOf(bot, "Deploy", "received", parent.spec.id)
    const { answer, sent, intakes } = harness([parent, running])
    return Effect.gen(function* () {
      yield* answer(event, { id: bot }, { kind: "id", id: parent.spec.id }, "pt")
      yield* answer(event, { id: bot }, { kind: "title", title: "Deploy" }, "pt")
      expect(intakes).toHaveLength(0)
      expect(sent).toEqual([
        `A tarefa ${parent.spec.id} já tem uma continuação em andamento: ${running.spec.id}.`,
        `A tarefa ${running.spec.id} ainda está em andamento. Só dá para continuar uma tarefa já terminada.`,
      ])
    })
  })

  it.effect("a task of another Bot with the same title is not matched", () => {
    const mine = newBotId()
    const theirs = newBotId()
    const { answer, sent, intakes } = harness([recordOf(theirs, "Deploy", "done")])
    return Effect.gen(function* () {
      yield* answer(event, { id: mine }, { kind: "title", title: "Deploy" }, "en")
      expect(intakes).toHaveLength(0)
      expect(sent).toEqual(['No task of this Bot matches "Deploy".'])
    })
  })

  it.effect("the query is echoed cut to 80 characters", () => {
    const { answer, sent } = harness([])
    const long = "x".repeat(200)
    return Effect.gen(function* () {
      yield* answer(event, { id: newBotId() }, { kind: "title", title: long }, "en")
      expect(sent[0]).toContain(`"${"x".repeat(80)}"`)
      expect(sent[0]).not.toContain("x".repeat(81))
    })
  })
})
