import type { BotId, SchemaViolation } from "@shoalwork/contracts"
import type { MemoryItem, ReefShape } from "@shoalwork/reef"
import { Effect } from "effect"
import type { SqlError } from "effect/sql/SqlError"

// What the memory commands need from the Reef. Tests implement the same four methods.
export type MemoryPort = Pick<ReefShape, "remember" | "search" | "forget" | "history">

export interface MemoryCommandInput {
  // The Bot that owns the topic the command came from; undefined outside a Bot topic.
  readonly botId: BotId | undefined
  // Telegram user id of the sender. Stored as the source "user:<id>".
  readonly userId: string
  readonly text: string
}

export interface MemoryButton {
  readonly label: string
  readonly data: string
}

export interface MemoryReply {
  readonly text: string
  readonly buttons: ReadonlyArray<MemoryButton>
}

// How many candidates /forget offers. One button per candidate, plus cancel.
export const FORGET_CANDIDATES = 3
export const MEMORY_CANCEL_DATA = "mem:cancel"
const FORGET_PREFIX = "mem:forget:"
// A Reef memory id is "mem_" + UUID (40 characters), so the callback stays under Telegram's 64-byte limit.
const MEMORY_ID_PATTERN = /^mem_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SNIPPET_CHARS = 120

const TEXT = {
  notInTopic: "Use /remember e /forget no tópico do Bot.",
  rememberUsage: "Uso: /remember <texto>",
  forgetUsage: "Uso: /forget <texto>",
  remembered: "Lembrado.",
  rememberFailed: "Não consegui gravar agora. Tente de novo em instantes.",
  noMatch: "Não encontrei nenhuma memória deste Bot sobre isso.",
  pick: "Qual memória esquecer? Toque no número.",
  cancelled: "Cancelado. Nada foi esquecido.",
  gone: "Essa memória não existe mais.",
  notOwned: "Essa memória não pertence a este Bot.",
  notLive: "Essa memória já foi esquecida ou substituída.",
  forgotten: (snippet: string) => `Esquecida: ${snippet}`,
} as const

export type MemoryCallback =
  | { readonly action: "forget"; readonly memoryId: string }
  | { readonly action: "cancel" }

export const forgetCallbackData = (memoryId: string): string => `${FORGET_PREFIX}${memoryId}`

// Data written by /forget buttons: "mem:forget:<memory id>" or "mem:cancel". Anything else is not a memory callback.
export const parseMemoryCallback = (data: string): MemoryCallback | undefined => {
  if (data === MEMORY_CANCEL_DATA) {
    return { action: "cancel" }
  }
  if (!data.startsWith(FORGET_PREFIX)) {
    return undefined
  }
  const memoryId = data.slice(FORGET_PREFIX.length)
  return MEMORY_ID_PATTERN.test(memoryId) ? { action: "forget", memoryId } : undefined
}

// Flattens and shortens stored text for a chat line. The full content never goes into a button.
const snippet = (content: string): string => {
  const flat = content.replace(/\s+/g, " ").trim()
  return flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS - 3)}...` : flat
}

const plain = (text: string): MemoryReply => ({ text, buttons: [] })

// "/remember <text>": a semantic memory of the topic's Bot. Embedder and validation failures become a reply.
export const rememberCommand = (
  memory: MemoryPort,
  input: MemoryCommandInput,
): Effect.Effect<MemoryReply, SqlError> => {
  const botId = input.botId
  if (botId === undefined) {
    return Effect.succeed(plain(TEXT.notInTopic))
  }
  const content = input.text.trim()
  if (content === "") {
    return Effect.succeed(plain(TEXT.rememberUsage))
  }
  return memory
    .remember({ scope: "bot", ownerId: botId, kind: "semantic", content, source: `user:${input.userId}` })
    .pipe(
      Effect.as(plain(TEXT.remembered)),
      Effect.catchTags({
        EmbedError: (error) =>
          Effect.logWarning("remember: embedder failed", error.reason).pipe(
            Effect.as(plain(TEXT.rememberFailed)),
          ),
        SchemaViolation: (error: SchemaViolation) =>
          Effect.logWarning("remember: rejected", error.where).pipe(Effect.as(plain(TEXT.rememberFailed))),
      }),
    )
}

// "/forget <text>": the topic's Bot's best matches as numbered buttons. Nothing is forgotten until a button is pressed.
export const forgetCommand = (
  memory: MemoryPort,
  input: MemoryCommandInput,
): Effect.Effect<MemoryReply, SqlError> => {
  const botId = input.botId
  if (botId === undefined) {
    return Effect.succeed(plain(TEXT.notInTopic))
  }
  const query = input.text.trim()
  if (query === "") {
    return Effect.succeed(plain(TEXT.forgetUsage))
  }
  return memory.search(query, { scopes: [{ scope: "bot", ownerId: botId }], k: FORGET_CANDIDATES }).pipe(
    Effect.map((hits): MemoryReply => {
      if (hits.length === 0) {
        return plain(TEXT.noMatch)
      }
      const lines = hits.map((hit, index) => `${index + 1}. ${snippet(hit.content)}`)
      return {
        text: [TEXT.pick, ...lines].join("\n"),
        buttons: [
          ...hits.map((hit, index) => ({ label: String(index + 1), data: forgetCallbackData(hit.id) })),
          { label: "cancelar", data: MEMORY_CANCEL_DATA },
        ],
      }
    }),
  )
}

// Forgets one item only when it is a live memory of the topic's Bot. Scope and owner are checked on the stored row,
// so a button can never reach another Bot's or the global memory.
const forgetOwned = (
  memory: MemoryPort,
  botId: BotId,
  memoryId: string,
): Effect.Effect<MemoryReply, SqlError> =>
  Effect.gen(function* () {
    const chain = yield* memory.history(memoryId)
    const item: MemoryItem | undefined = chain.find((candidate) => candidate.id === memoryId)
    if (item === undefined) {
      return plain(TEXT.gone)
    }
    if (item.scope !== "bot" || item.owner_id !== botId) {
      return plain(TEXT.notOwned)
    }
    if (item.tombstone === 1 || item.superseded_by !== null) {
      return plain(TEXT.notLive)
    }
    return yield* memory.forget(memoryId).pipe(
      Effect.as(plain(TEXT.forgotten(snippet(item.content)))),
      Effect.catchTag("NotFound", () => Effect.succeed(plain(TEXT.gone))),
    )
  })

// Handles a parsed "mem:" callback for the topic it came from. Cancel changes nothing.
export const memoryCallback = (
  memory: MemoryPort,
  input: { readonly botId: BotId | undefined; readonly callback: MemoryCallback },
): Effect.Effect<MemoryReply, SqlError> => {
  if (input.callback.action === "cancel") {
    return Effect.succeed(plain(TEXT.cancelled))
  }
  const botId = input.botId
  if (botId === undefined) {
    return Effect.succeed(plain(TEXT.notInTopic))
  }
  return forgetOwned(memory, botId, input.callback.memoryId)
}
