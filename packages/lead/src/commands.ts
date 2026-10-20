import type { BotState } from "@shoalwork/contracts"
import type { Lang } from "./narrator.js"

// Slash commands of the conversation (intent "system"). The text of a command is a fixed table per language.
// "memory" is the command a /forget button press becomes (currents memoryCallbackText).
export type Command =
  | "status"
  | "help"
  | "start"
  | "stop"
  | "pause"
  | "resume"
  | "remember"
  | "forget"
  | "memory"

const COMMANDS: ReadonlyArray<Command> = [
  "status",
  "help",
  "start",
  "stop",
  "pause",
  "resume",
  "remember",
  "forget",
  "memory",
]

export interface Invocation {
  readonly command: Command
  readonly args: ReadonlyArray<string>
}

// "/status", "/status@my_bot" and "/status extra words" all name the command "status". Unknown names give undefined.
// The words after the command name are its arguments ("/stop task task_1" -> ["task", "task_1"]).
export const parseInvocation = (text: string): Invocation | undefined => {
  const [word = "", ...args] = text.trim().split(/\s+/)
  if (!word.startsWith("/")) {
    return undefined
  }
  const name = word.slice(1).split("@", 1)[0]?.toLowerCase()
  const command = COMMANDS.find((candidate) => candidate === name)
  return command === undefined ? undefined : { command, args }
}

export const parseCommand = (text: string): Command | undefined => parseInvocation(text)?.command

// What a stop, pause or resume was asked to act on, as the command named it.
export type ControlRequest =
  | { readonly action: "stop" | "pause" | "resume"; readonly scope: "global" }
  | { readonly action: "stop" | "pause" | "resume"; readonly scope: "bot"; readonly name: string }
  | { readonly action: "stop"; readonly scope: "task"; readonly id: string }

// "/stop", "/stop <bot>", "/stop task <id>", "/pause [<bot>]", "/resume [<bot>]". Anything else is a usage error.
export const parseControl = (invocation: Invocation): ControlRequest | undefined => {
  const { command, args } = invocation
  if (command !== "stop" && command !== "pause" && command !== "resume") {
    return undefined
  }
  const [first, second, ...rest] = args
  if (first === undefined) {
    return { action: command, scope: "global" }
  }
  if (command === "stop" && first.toLowerCase() === "task") {
    return second === undefined || rest.length > 0 ? undefined : { action: "stop", scope: "task", id: second }
  }
  return second === undefined ? { action: command, scope: "bot", name: first } : undefined
}

export interface BotRow {
  readonly name: string
  readonly state: BotState
  readonly running: number
}

interface Texts {
  readonly help: string
  readonly statusTitle: string
  readonly noBots: string
  readonly running: (count: number) => string
  readonly unknown: string
  readonly globalPaused: string
  readonly controlUsage: string
  readonly controlFailed: string
  readonly unknownBot: (name: string) => string
  readonly unknownTask: (id: string) => string
  readonly control: (request: ControlRequest, count: number) => string
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

const TEXTS: Record<Lang, Texts> = {
  pt: {
    help: "Comandos: /status (Bots e tarefas), /stop [bot | task <id>], /pause [bot], /resume [bot], /remember <texto>, /forget <texto>, /help. Qualquer outra mensagem é uma conversa ou um pedido.",
    statusTitle: "Bots:",
    noBots: "Nenhum Bot cadastrado.",
    running: (count) =>
      count === 0 ? "" : ` — ${count} ${count === 1 ? "tarefa rodando" : "tarefas rodando"}`,
    unknown: "Comando desconhecido. Use /help.",
    globalPaused: "Tudo pausado (/resume libera).",
    controlUsage: "Uso: /stop [bot | task <id>], /pause [bot], /resume [bot].",
    controlFailed: "Não consegui executar o comando. Veja os eventos de erro.",
    unknownBot: (name) => `Bot desconhecido: ${name}.`,
    unknownTask: (id) => `Tarefa desconhecida: ${id}.`,
    control: (request, count) => {
      const what = request.scope === "global" ? "Tudo" : request.scope === "bot" ? request.name : request.id
      if (request.action === "resume") {
        return `${what} retomado.`
      }
      if (request.action === "pause") {
        return `${what} pausado. As tarefas em andamento continuam; nada novo começa. /resume libera.`
      }
      if (request.scope === "task") {
        return count > 0 ? `Tarefa ${request.id} parada.` : `Tarefa ${request.id} já tinha terminado.`
      }
      const done = count > 0 ? plural(count, "tarefa cancelada", "tarefas canceladas") : "nada para parar"
      return `${what} parado: ${done}.`
    },
  },
  en: {
    help: "Commands: /status (Bots and tasks), /stop [bot | task <id>], /pause [bot], /resume [bot], /remember <text>, /forget <text>, /help. Any other message is a chat or a request.",
    statusTitle: "Bots:",
    noBots: "No Bots registered.",
    running: (count) => (count === 0 ? "" : ` — ${count} running ${count === 1 ? "task" : "tasks"}`),
    unknown: "Unknown command. Use /help.",
    globalPaused: "Everything is paused (/resume releases).",
    controlUsage: "Usage: /stop [bot | task <id>], /pause [bot], /resume [bot].",
    controlFailed: "I could not run the command. Check the error events.",
    unknownBot: (name) => `Unknown Bot: ${name}.`,
    unknownTask: (id) => `Unknown task: ${id}.`,
    control: (request, count) => {
      const what =
        request.scope === "global" ? "Everything" : request.scope === "bot" ? request.name : request.id
      if (request.action === "resume") {
        return `${what} resumed.`
      }
      if (request.action === "pause") {
        return `${what} paused. Running tasks go on; nothing new starts. /resume releases.`
      }
      if (request.scope === "task") {
        return count > 0 ? `Task ${request.id} stopped.` : `Task ${request.id} had already finished.`
      }
      const done = count > 0 ? `${plural(count, "task", "tasks")} cancelled` : "nothing to stop"
      return `${what} stopped: ${done}.`
    },
  },
  es: {
    help: "Comandos: /status (Bots y tareas), /stop [bot | task <id>], /pause [bot], /resume [bot], /remember <texto>, /forget <texto>, /help. Cualquier otro mensaje es una charla o un pedido.",
    statusTitle: "Bots:",
    noBots: "Ningún Bot registrado.",
    running: (count) =>
      count === 0 ? "" : ` — ${count} ${count === 1 ? "tarea en curso" : "tareas en curso"}`,
    unknown: "Comando desconocido. Usa /help.",
    globalPaused: "Todo en pausa (/resume lo libera).",
    controlUsage: "Uso: /stop [bot | task <id>], /pause [bot], /resume [bot].",
    controlFailed: "No pude ejecutar el comando. Revisa los eventos de error.",
    unknownBot: (name) => `Bot desconocido: ${name}.`,
    unknownTask: (id) => `Tarea desconocida: ${id}.`,
    control: (request, count) => {
      const what = request.scope === "global" ? "Todo" : request.scope === "bot" ? request.name : request.id
      if (request.action === "resume") {
        return `${what} reanudado.`
      }
      if (request.action === "pause") {
        return `${what} en pausa. Las tareas en curso siguen; nada nuevo empieza. /resume lo libera.`
      }
      if (request.scope === "task") {
        return count > 0 ? `Tarea ${request.id} detenida.` : `La tarea ${request.id} ya había terminado.`
      }
      const done = count > 0 ? plural(count, "tarea cancelada", "tareas canceladas") : "nada que detener"
      return `${what} detenido: ${done}.`
    },
  },
}

export const statusText = (rows: ReadonlyArray<BotRow>, language: Lang, globalPaused = false): string => {
  const texts = TEXTS[language]
  if (rows.length === 0) {
    return texts.noBots
  }
  const lines = rows.map((row) => `• ${row.name} — ${row.state}${texts.running(row.running)}`)
  return [...(globalPaused ? [texts.globalPaused] : []), texts.statusTitle, ...lines].join("\n")
}

export const controlText = (request: ControlRequest, count: number, language: Lang): string =>
  TEXTS[language].control(request, count)

export const unknownCommandText = (language: Lang): string => TEXTS[language].unknown
export const controlUsageText = (language: Lang): string => TEXTS[language].controlUsage
export const controlFailedText = (language: Lang): string => TEXTS[language].controlFailed
export const unknownBotText = (name: string, language: Lang): string => TEXTS[language].unknownBot(name)
export const unknownTaskText = (id: string, language: Lang): string => TEXTS[language].unknownTask(id)

// Reply of every command that needs no data. `status` and the control commands are built by the caller.
export const staticReply = (command: Command | undefined, language: Lang): string => {
  const texts = TEXTS[language]
  if (command === "help" || command === "start") {
    return texts.help
  }
  return texts.unknown
}
