import { MAX_ATTEMPTS } from "./retry.js"
import { clip } from "./verdict.js"

// Pure phrases for Renan: a fixed table per language. Sending them is the conversation's job (narrate.ts).
export type Lang = "pt" | "en" | "es"

// Reflex reports "other" when its stopword rules find nothing; Portuguese (Renan's language) is the fallback.
export const langOf = (language: string | undefined): Lang =>
  language === "en" || language === "es" ? language : "pt"

export const DIAGNOSIS_MAX = 200
export const COMMAND_MAX = 60
// A verdict summary longer than this is summarised by the chat tier before it is shown.
export const SUMMARY_LONG = 300
// At most one progress message per task in this window; urgent messages are never held back.
export const COALESCE_MS = 20_000

interface Phrases {
  readonly ack: (owner: string) => string
  readonly ackUnnamed: string
  readonly reassigned: (owner: string) => string
  readonly started: string
  readonly tests: string
  readonly command: (cmd: string) => string
  readonly edit: (file: string) => string
  readonly retrying: (attempt: number) => string
  readonly done: (summary: string) => string
  readonly failed: (reason: string) => string
  readonly needsYou: (diagnosis: string) => string
  readonly cancelled: string
  readonly budget: string
  readonly botBudget: string
  readonly timeout: string
  readonly chatFailed: string
  readonly noOwner: string
}

const PHRASES: Record<Lang, Phrases> = {
  pt: {
    ack: (owner) => `Entendi, passei para ${owner}.`,
    ackUnnamed: "Entendi, já vejo isso.",
    reassigned: (owner) => `Corrigindo: passei para ${owner}.`,
    started: "Comecei.",
    tests: "Rodando testes…",
    command: (cmd) => `Rodando: ${cmd}`,
    edit: (file) => `Editando ${file}…`,
    retrying: (attempt) => `Tentando de novo (${attempt}/${MAX_ATTEMPTS})…`,
    done: (summary) => `Terminei: ${summary}`,
    failed: (reason) => `Falhou: ${reason}`,
    needsYou: (diagnosis) => `Precisa de você: ${diagnosis}`,
    cancelled: "Cancelado.",
    budget: "Estourou o orçamento da tarefa; parei.",
    botBudget: "Orçamento do Bot estourado: esta tarefa não roda até você liberar o Bot.",
    timeout: "Demorei demais, tenta de novo.",
    chatFailed: "Não consegui responder agora, tenta de novo.",
    noOwner: "Não achei um Bot para isso.",
  },
  en: {
    ack: (owner) => `Got it, handed it to ${owner}.`,
    ackUnnamed: "Got it, looking into it.",
    reassigned: (owner) => `Correction: handed it to ${owner}.`,
    started: "Started.",
    tests: "Running tests…",
    command: (cmd) => `Running: ${cmd}`,
    edit: (file) => `Editing ${file}…`,
    retrying: (attempt) => `Trying again (${attempt}/${MAX_ATTEMPTS})…`,
    done: (summary) => `Done: ${summary}`,
    failed: (reason) => `Failed: ${reason}`,
    needsYou: (diagnosis) => `Needs you: ${diagnosis}`,
    cancelled: "Cancelled.",
    budget: "The task budget ran out; I stopped.",
    botBudget: "The Bot's budget ran out: this task will not run until you release the Bot.",
    timeout: "That took too long, try again.",
    chatFailed: "I could not answer right now, try again.",
    noOwner: "I found no Bot for that.",
  },
  es: {
    ack: (owner) => `Entendido, se lo pasé a ${owner}.`,
    ackUnnamed: "Entendido, lo reviso.",
    reassigned: (owner) => `Corrección: se lo pasé a ${owner}.`,
    started: "Empecé.",
    tests: "Ejecutando pruebas…",
    command: (cmd) => `Ejecutando: ${cmd}`,
    edit: (file) => `Editando ${file}…`,
    retrying: (attempt) => `Reintentando (${attempt}/${MAX_ATTEMPTS})…`,
    done: (summary) => `Terminé: ${summary}`,
    failed: (reason) => `Falló: ${reason}`,
    needsYou: (diagnosis) => `Te necesita: ${diagnosis}`,
    cancelled: "Cancelado.",
    budget: "Se agotó el presupuesto de la tarea; paré.",
    botBudget: "Se agotó el presupuesto del Bot: esta tarea no se ejecuta hasta que liberes el Bot.",
    timeout: "Tardé demasiado, inténtalo de nuevo.",
    chatFailed: "No pude responder ahora, inténtalo de nuevo.",
    noOwner: "No encontré un Bot para eso.",
  },
}

// One line, no raw executor output: collapses whitespace and cuts to `max`.
export const oneLine = (text: string, max: number): string => clip(text.replace(/\s+/g, " ").trim(), max)

// Executor text (commands, summaries, failure reasons) is shown to Renan on Telegram only after this pass: a line that
// names a token, key, secret or password, or holds a known credential shape, is replaced whole (same rule as the
// executors' stderr tail); URLs with user info keep only scheme and host.
// Written so the source does not match the repo's own secret grep (G-NO-SECRETS).
const SECRET_LINE = /token|key|secret|password|passwd|authorization|bearer/i
const SECRET_SHAPES: ReadonlyArray<RegExp> = [
  /\bsk-[A-Za-z0-9_-]{8,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pa[t]_\w{20,}/,
  /\bAKI[A][0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
]
const URL_CREDENTIALS = /:\/\/[^@/\s]+@/g

export const redactSecrets = (text: string): string =>
  text
    .split("\n")
    .map((line) =>
      SECRET_LINE.test(line) || SECRET_SHAPES.some((shape) => shape.test(line))
        ? "[redacted]"
        : line.replace(URL_CREDENTIALS, "://***@"),
    )
    .join("\n")

// Redacted, then one line.
export const safeLine = (text: string, max: number): string => oneLine(redactSecrets(text), max)

const TEST_COMMAND = /\b(test|tests|vitest|jest|pytest|mocha)\b/i

const baseName = (path: string): string => path.split("/").filter(Boolean).at(-1) ?? path

export const ack = (language: Lang, owner: string): string => PHRASES[language].ack(owner)
export const ackUnnamedPhrase = (language: Lang): string => PHRASES[language].ackUnnamed
export const reassignedPhrase = (language: Lang, owner: string): string => PHRASES[language].reassigned(owner)
export const startedPhrase = (language: Lang = "pt"): string => PHRASES[language].started
export const timeoutPhrase = (language: Lang = "pt"): string => PHRASES[language].timeout
export const chatFailedPhrase = (language: Lang = "pt"): string => PHRASES[language].chatFailed
export const noOwnerPhrase = (language: Lang = "pt"): string => PHRASES[language].noOwner
export const cancelledPhrase = (language: Lang = "pt"): string => PHRASES[language].cancelled
export const budgetPhrase = (language: Lang = "pt"): string => PHRASES[language].budget
export const botBudgetPhrase = (language: Lang = "pt"): string => PHRASES[language].botBudget

// `attempt` is the number of the new run: the retry after the first failure is "2/2".
export const retryingPhrase = (attempt: number, language: Lang = "pt"): string =>
  PHRASES[language].retrying(attempt)

// Escalation after the last attempt failed: the short diagnosis, never the raw executor output.
export const needsYouPhrase = (diagnosis: string, language: Lang = "pt"): string =>
  PHRASES[language].needsYou(safeLine(diagnosis, DIAGNOSIS_MAX))

export const commandPhrase = (cmd: string, language: Lang = "pt"): string =>
  TEST_COMMAND.test(cmd) ? PHRASES[language].tests : PHRASES[language].command(safeLine(cmd, COMMAND_MAX))

export const editPhrase = (path: string, language: Lang = "pt"): string =>
  PHRASES[language].edit(baseName(path))

export const donePhrase = (summary: string, language: Lang = "pt"): string =>
  PHRASES[language].done(safeLine(summary, SUMMARY_LONG))

export const failedPhrase = (reason: string, language: Lang = "pt"): string =>
  PHRASES[language].failed(safeLine(reason, DIAGNOSIS_MAX))

// Whether a progress message may go out now: the first one always, then one per window. Urgent ones always.
export const mayNarrate = (nowMs: number, lastSentMs: number | undefined, urgent: boolean): boolean =>
  urgent || lastSentMs === undefined || nowMs - lastSentMs >= COALESCE_MS
