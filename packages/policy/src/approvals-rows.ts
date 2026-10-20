import { createHash } from "node:crypto"
import {
  type Approval,
  ApprovalId,
  ApprovalStatus,
  BotId,
  Risk,
  SessionId,
  StepId,
  TaskId,
  type ToolCall,
} from "@shoalwork/contracts"
import { DateTime, Effect, Schema } from "effect"
import { redactResource } from "./policy.js"
import { redactText } from "./redact.js"

const INPUT_MAX_CHARS = 2000

// An approval plus what the runner and the Telegram card need to find it again.
export interface ApprovalRecord extends Approval {
  readonly stepId?: StepId
  readonly sessionId?: SessionId
  // sha256 of tool + canonical input, taken before redaction. consumeMatching enforces it for the inline bridge (T-055).
  readonly actionHash: string
  readonly consumedAt?: DateTime.Utc
  readonly chatId?: string
  readonly threadId?: number
  readonly messageId?: number
}

const ActionJson = Schema.Struct({
  tool: Schema.String,
  input: Schema.Unknown,
  resource: Schema.optional(Schema.String),
})

const Row = Schema.Struct({
  id: ApprovalId,
  task_id: TaskId,
  bot_id: BotId,
  step_id: Schema.NullOr(StepId),
  session_id: Schema.NullOr(SessionId),
  action: Schema.String,
  action_hash: Schema.String,
  risk: Risk,
  status: ApprovalStatus,
  requested_at: Schema.String,
  expires_at: Schema.String,
  resolved_at: Schema.NullOr(Schema.String),
  resolved_by: Schema.NullOr(Schema.String),
  consumed_at: Schema.NullOr(Schema.String),
  chat_id: Schema.NullOr(Schema.String),
  thread_id: Schema.NullOr(Schema.Int),
  message_id: Schema.NullOr(Schema.Int),
})
type Row = typeof Row.Type

const parseJson = (text: string): Effect.Effect<unknown> =>
  Effect.try({ try: (): unknown => JSON.parse(text), catch: (cause) => cause }).pipe(Effect.orDie)

const utc = (iso: string): DateTime.Utc => DateTime.makeUnsafe(iso)

// Rows are written by this module only: a mismatch is a bug, so it dies instead of becoming a typed error.
const toRecord = (row: Row): Effect.Effect<ApprovalRecord> =>
  Effect.gen(function* () {
    const action = yield* parseJson(row.action).pipe(
      Effect.flatMap((raw) => Schema.decodeUnknownEffect(ActionJson)(raw)),
      Effect.orDie,
    )
    return {
      id: row.id,
      taskId: row.task_id,
      botId: row.bot_id,
      action,
      actionHash: row.action_hash,
      risk: row.risk,
      status: row.status,
      requestedAt: utc(row.requested_at),
      expiresAt: utc(row.expires_at),
      ...(row.resolved_at === null ? {} : { resolvedAt: utc(row.resolved_at) }),
      ...(row.resolved_by === null ? {} : { resolvedBy: row.resolved_by }),
      ...(row.consumed_at === null ? {} : { consumedAt: utc(row.consumed_at) }),
      ...(row.step_id === null ? {} : { stepId: row.step_id }),
      ...(row.session_id === null ? {} : { sessionId: row.session_id }),
      ...(row.chat_id === null ? {} : { chatId: row.chat_id }),
      ...(row.thread_id === null ? {} : { threadId: row.thread_id }),
      ...(row.message_id === null ? {} : { messageId: row.message_id }),
    }
  })

export const toRecords = (rows: ReadonlyArray<unknown>): Effect.Effect<ReadonlyArray<ApprovalRecord>> =>
  Schema.decodeUnknownEffect(Schema.Array(Row))(rows).pipe(
    Effect.orDie,
    Effect.flatMap((decoded) => Effect.forEach(decoded, toRecord)),
  )

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : typeof value === "object" && value !== null
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([key, entry]) => [key, canonical(entry)]),
        )
      : value

const inputText = (input: unknown): string =>
  typeof input === "string" ? input : (JSON.stringify(canonical(input)) ?? "")

// Binds a decision to the action that was asked: sha256 of the JSON array [tool, canonical input], before any cut or
// redaction. A JSON array keeps the two parts apart (a tool name holding "\n" cannot be read as an input), and a string
// input never collides with an object input.
export const actionHashOf = (call: ToolCall): string =>
  createHash("sha256")
    .update(JSON.stringify([call.tool, canonical(call.input)]) ?? "")
    .digest("hex")

// What is stored and sent: the resource and the input are redacted and cut. The model's own text is data (R14).
export const boundedAction = (call: ToolCall): ToolCall => {
  const input = redactText(inputText(call.input)).slice(0, INPUT_MAX_CHARS)
  return {
    tool: call.tool,
    input,
    ...(call.resource === undefined ? {} : { resource: redactResource(call.resource) }),
  }
}
