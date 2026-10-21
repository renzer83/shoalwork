import type { Bot, BotId, Event, TaskId, TaskSpec } from "@shoalwork/contracts"
import { Effect } from "effect"
import type { LeadShape } from "./lead.js"
import { botBudgetPhrase, type Lang, oneLine } from "./narrator.js"
import type { ReplyChannel } from "./reply-port.js"
import { continuationOf, matchTasks, planResume, type ResumeRequest } from "./resume-request.js"
import type { TaskStoreShape } from "./tasks.js"

// The candidates of an ambiguous title, newest first; enough to pick the id from.
const LIST_MAX = 5
// The request is echoed back as the user typed it, cut to this many characters.
const QUERY_MAX = 80

interface Texts {
  readonly resumed: (title: string, id: TaskId) => string
  readonly unknown: (query: string) => string
  readonly running: (id: TaskId) => string
  readonly continued: (parent: TaskId, child: TaskId) => string
  readonly ambiguous: (query: string) => string
  readonly failed: string
}

const TEXTS: Record<Lang, Texts> = {
  pt: {
    resumed: (title, id) => `Continuando "${title}" como tarefa ${id}.`,
    unknown: (query) => `Nenhuma tarefa deste Bot corresponde a "${query}".`,
    running: (id) => `A tarefa ${id} ainda está em andamento. Só dá para continuar uma tarefa já terminada.`,
    continued: (parent, child) => `A tarefa ${parent} já tem uma continuação em andamento: ${child}.`,
    ambiguous: (query) =>
      `Mais de uma tarefa corresponde a "${query}". Responda com o id: continua a task <id>.`,
    failed: "Não consegui retomar a tarefa. Veja os eventos de erro.",
  },
  en: {
    resumed: (title, id) => `Continuing "${title}" as task ${id}.`,
    unknown: (query) => `No task of this Bot matches "${query}".`,
    running: (id) => `Task ${id} is still running. Only a finished task can be continued.`,
    continued: (parent, child) => `Task ${parent} already has a continuation under way: ${child}.`,
    ambiguous: (query) => `More than one task matches "${query}". Answer with the id: continue task <id>.`,
    failed: "I could not resume the task. Check the error events.",
  },
  es: {
    resumed: (title, id) => `Continuando "${title}" como tarea ${id}.`,
    unknown: (query) => `Ninguna tarea de este Bot coincide con "${query}".`,
    running: (id) => `La tarea ${id} sigue en curso. Solo se puede continuar una tarea terminada.`,
    continued: (parent, child) => `La tarea ${parent} ya tiene una continuación en curso: ${child}.`,
    ambiguous: (query) =>
      `Más de una tarea coincide con "${query}". Responde con el id: continúa la task <id>.`,
    failed: "No pude retomar la tarea. Revisa los eventos de error.",
  },
}

const queryOf = (request: ResumeRequest): string => (request.kind === "id" ? request.id : request.title)

export interface ResumeDeps {
  readonly tasks: TaskStoreShape
  readonly lead: LeadShape
  readonly say: (botId: BotId, text: string, inReplyTo?: Event["id"]) => Effect.Effect<void>
  readonly languages: Map<TaskId, Lang>
  readonly channel: ReplyChannel
}

// "continua a task <id|título>" in a Bot's topic. Only the tasks of that Bot can be continued, and only once they have
// finished, and only one continuation of a task may be under way. A finished task becomes a new task of the same Bot
// that names it as `resumeOf`: the Lead runs it with the parent's worktree and session when they still exist
// (resume.ts). Never fails: a problem becomes the reply.
export const makeResumeAnswers =
  (deps: ResumeDeps) =>
  (
    event: Pick<Event, "id" | "correlationId">,
    bot: Pick<Bot, "id">,
    request: ResumeRequest,
    language: Lang,
  ) => {
    const { tasks, lead, say, languages, channel } = deps
    const texts = TEXTS[language]
    const query = oneLine(queryOf(request), QUERY_MAX)
    const resume = (title: string, parentId: TaskId, spec: Parameters<LeadShape["intake"]>[0]) =>
      Effect.gen(function* () {
        const child = yield* lead.intake({ ...spec, correlationId: event.correlationId, resumeOf: parentId })
        languages.set(child.id, language)
        const stored = yield* lead.get(child.id)
        // Refused for the Bot's budget: the intake already recorded the task as failed.
        if (stored.state === "failed" && stored.verdict?.kind === "budget_exceeded") {
          return yield* say(bot.id, botBudgetPhrase(language), event.id)
        }
        return yield* say(bot.id, texts.resumed(title, child.id), event.id)
      })
    return Effect.gen(function* () {
      const records = yield* tasks.listByBot(bot.id)
      const plan = planResume(matchTasks(records, request))
      switch (plan._tag) {
        case "None":
          return yield* say(bot.id, texts.unknown(query), event.id)
        case "Ambiguous": {
          const lines = plan.records
            .slice(0, LIST_MAX)
            .map(
              (record) => `• ${record.spec.id} — ${oneLine(record.spec.title, QUERY_MAX)} (${record.state})`,
            )
          return yield* say(bot.id, [texts.ambiguous(query), ...lines].join("\n"), event.id)
        }
        case "Running":
          return yield* say(bot.id, texts.running(plan.record.spec.id), event.id)
        case "Resume": {
          const { spec } = plan.record
          // A continuation already under way answers for the task: the same id, asked by id or by title.
          const running = continuationOf(records, spec.id)
          if (running !== undefined) {
            return yield* say(bot.id, texts.continued(spec.id, running.spec.id), event.id)
          }
          const fields: Omit<TaskSpec, "id" | "tier" | "resumeOf" | "correlationId"> & {
            tier: TaskSpec["tier"]
          } = {
            botId: spec.botId,
            title: spec.title,
            prompt: spec.prompt,
            kind: spec.kind,
            ...(spec.repo === undefined ? {} : { repo: spec.repo }),
            acceptance: spec.acceptance,
            budget: spec.budget,
            tier: spec.tier,
            origin: channel,
          }
          return yield* resume(spec.title, spec.id, fields)
        }
      }
    }).pipe(Effect.catch(() => say(bot.id, texts.failed, event.id)))
  }
