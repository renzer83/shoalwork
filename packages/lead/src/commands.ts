import type { BotState } from "@shoalwork/contracts"
import type { Lang } from "./narrator.js"

// Slash commands of the conversation (intent "system"). The text of a command is a fixed table per language.
export type Command = "status" | "help" | "start" | "stop" | "pause" | "resume"

const COMMANDS: ReadonlyArray<Command> = ["status", "help", "start", "stop", "pause", "resume"]

// "/status", "/status@my_bot" and "/status extra words" all name the command "status". Unknown names give undefined.
export const parseCommand = (text: string): Command | undefined => {
  const word = text.trim().split(/\s+/, 1)[0] ?? ""
  if (!word.startsWith("/")) {
    return undefined
  }
  const name = word.slice(1).split("@", 1)[0]?.toLowerCase()
  return COMMANDS.find((command) => command === name)
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
  readonly unavailable: string
  readonly unknown: string
}

const TEXTS: Record<Lang, Texts> = {
  pt: {
    help: "Comandos: /status (Bots e tarefas), /help. /stop, /pause e /resume chegam em breve. Qualquer outra mensagem é uma conversa ou um pedido.",
    statusTitle: "Bots:",
    noBots: "Nenhum Bot cadastrado.",
    running: (count) =>
      count === 0 ? "" : ` — ${count} ${count === 1 ? "tarefa rodando" : "tarefas rodando"}`,
    unavailable: "Ainda não disponível.",
    unknown: "Comando desconhecido. Use /help.",
  },
  en: {
    help: "Commands: /status (Bots and tasks), /help. /stop, /pause and /resume are coming. Any other message is a chat or a request.",
    statusTitle: "Bots:",
    noBots: "No Bots registered.",
    running: (count) => (count === 0 ? "" : ` — ${count} running ${count === 1 ? "task" : "tasks"}`),
    unavailable: "Not available yet.",
    unknown: "Unknown command. Use /help.",
  },
  es: {
    help: "Comandos: /status (Bots y tareas), /help. /stop, /pause y /resume llegan pronto. Cualquier otro mensaje es una charla o un pedido.",
    statusTitle: "Bots:",
    noBots: "Ningún Bot registrado.",
    running: (count) =>
      count === 0 ? "" : ` — ${count} ${count === 1 ? "tarea en curso" : "tareas en curso"}`,
    unavailable: "Aún no disponible.",
    unknown: "Comando desconocido. Usa /help.",
  },
}

export const statusText = (rows: ReadonlyArray<BotRow>, language: Lang): string => {
  const texts = TEXTS[language]
  if (rows.length === 0) {
    return texts.noBots
  }
  const lines = rows.map((row) => `• ${row.name} — ${row.state}${texts.running(row.running)}`)
  return [texts.statusTitle, ...lines].join("\n")
}

// Reply of every command that needs no data. `status` is built by the caller from the registry.
export const staticReply = (command: Command | undefined, language: Lang): string => {
  const texts = TEXTS[language]
  if (command === "help" || command === "start") {
    return texts.help
  }
  if (command === "stop" || command === "pause" || command === "resume") {
    return texts.unavailable
  }
  return texts.unknown
}
