import { randomUUID } from "node:crypto"
import type { BotRegistryShape } from "@shoalwork/bots"
import { writeBotYaml } from "@shoalwork/bots"
import { type BotId, NewBot } from "@shoalwork/contracts"
import {
  botProposalButtons,
  type MessageRef,
  PROPOSAL_ID,
  type SendFlags,
  type TelegramOutShape,
} from "@shoalwork/currents"
import { Clock, Effect, Option, Schema } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import {
  buildPrompt,
  type ConfirmKind,
  type ConfirmOutcome,
  checkProposal,
  freeName,
  NOT_BUILT,
  PROPOSAL_STATUSES,
  ProposalInvalid,
  type ProposalRef,
  type ProposalRules,
  type ProposalStatus,
  type ProposeOutcome,
  proposalHtml,
  REPLIES,
} from "./bot-proposal.js"
import type { ChatFailure } from "./chat.js"

export {
  type ConfirmCommand,
  type ConfirmKind,
  type ConfirmOutcome,
  isCreateBotRequest,
  type ProposalRef,
  type ProposalStatus,
  type ProposeOutcome,
  parseConfirmBot,
} from "./bot-proposal.js"

// Bots created by conversation: a proposal is never a Bot until Renan confirms it, and is decided once.

export const PROPOSAL_TTL_MS = 60 * 60 * 1000

export interface BotFactoryConfig extends ProposalRules {
  readonly proposalTtlMs?: number
}

export interface BotFactoryDeps {
  readonly sql: SqlClient
  readonly bots: BotRegistryShape
  readonly telegram: TelegramOutShape
  // One prompt in, the model's text out. The composition root binds the heavy tier (chat.heavy); no tool is involved.
  readonly ask: (prompt: string) => Effect.Effect<string, ChatFailure>
  readonly botsDir: string
  // Executors known to the registry. The chat executor is filtered out: it is never a Bot's executor.
  readonly executors: ReadonlyArray<string>
  readonly config: BotFactoryConfig
}

const ProposalRow = Schema.Struct({
  id: Schema.String,
  requested_by: Schema.String,
  proposal: Schema.String,
  status: PROPOSAL_STATUSES,
  expires_at: Schema.String,
  message_chat_id: Schema.NullOr(Schema.String),
  message_id: Schema.NullOr(Schema.Int),
})
type ProposalRow = typeof ProposalRow.Type
const ProposalRows = Schema.Array(ProposalRow)

const decodeStoredBot = Schema.decodeUnknownOption(Schema.fromJsonString(NewBot))

const iso = (millis: number): string => new Date(millis).toISOString()

// Replies go to the topic of the request; a failed send is logged.
const say = (deps: BotFactoryDeps, botId: BotId, text: string, flags?: SendFlags) =>
  deps.telegram
    .send(botId, text, flags)
    .pipe(Effect.catch((error) => Effect.logWarning("bot factory reply not sent", error.op)))

const proposeWithRetry = (deps: BotFactoryDeps, request: string) => {
  const env = { executors: deps.executors, rules: deps.config }
  const ask = (previousReason: string | undefined) =>
    deps.ask(buildPrompt(env, request, previousReason)).pipe(
      Effect.mapError(() => new ProposalInvalid({ reason: "the model gave no answer" })),
      Effect.flatMap((reply) => checkProposal(reply, env)),
    )
  // One retry, with the reason of the first refusal. A second refusal is final.
  return ask(undefined).pipe(Effect.catchTag("ProposalInvalid", (first) => ask(first.reason)))
}

// Asks the heavy tier for a Bot, stores the checked definition as a pending proposal and sends it with the buttons.
export const proposeBot = (
  deps: BotFactoryDeps,
  input: { readonly botId: BotId; readonly requestedBy: string; readonly text: string },
): Effect.Effect<ProposeOutcome, SqlError> =>
  Effect.gen(function* () {
    const checked = yield* proposeWithRetry(deps, input.text).pipe(
      Effect.catch((refusal) => Effect.succeed(refusal)),
    )
    if (checked instanceof ProposalInvalid) {
      yield* say(deps, input.botId, NOT_BUILT)
      return { kind: "invalid", reason: checked.reason }
    }
    const ttlMs = deps.config.proposalTtlMs ?? PROPOSAL_TTL_MS
    const now = yield* Clock.currentTimeMillis
    const proposalId = `prop_${randomUUID()}`
    yield* deps.sql`INSERT INTO bot_proposals (id, requested_by, proposal, status, created_at, expires_at)
      VALUES (${proposalId}, ${input.requestedBy}, ${JSON.stringify(checked)}, 'pending', ${iso(now)}, ${iso(now + ttlMs)})`
    // The model's fields are escaped by proposalHtml; the message is sent as HTML so the bold title and code render.
    const ref: MessageRef | undefined = yield* deps.telegram
      .sendRef(input.botId, proposalHtml(checked, ttlMs), {
        html: true,
        replyMarkup: botProposalButtons(proposalId),
      })
      .pipe(
        Effect.catch((error) => Effect.logWarning("proposal not sent", error.op).pipe(Effect.as(undefined))),
      )
    if (ref !== undefined) {
      // Kept so the buttons can be removed when the proposal is decided or expires.
      yield* deps.sql`UPDATE bot_proposals SET message_chat_id = ${ref.chatId}, message_id = ${ref.messageId}
        WHERE id = ${proposalId}`
    }
    return { kind: "proposed", proposalId, botName: checked.name, status: "pending" }
  })

const outcomeOf = (kind: ConfirmKind, proposal?: ProposalRef): ConfirmOutcome =>
  proposal === undefined ? { kind } : { kind, ...proposal, name: proposal.botName }

// The proposal as the row shows it, with the status the caller just moved it to.
const refOf = (row: ProposalRow, status: ProposalStatus): ProposalRef => ({
  proposalId: row.id,
  botName: Option.match(decodeStoredBot(row.proposal), {
    onNone: () => "",
    onSome: (bot) => bot.name,
  }),
  status,
})

// Sends the fixed reply for a non-created outcome, then reports it.
const answer = (
  deps: BotFactoryDeps,
  replyTo: BotId,
  kind: Exclude<ConfirmKind, "created">,
  proposal?: ProposalRef,
) => say(deps, replyTo, REPLIES[kind]).pipe(Effect.as(outcomeOf(kind, proposal)))

const readProposal = (sql: SqlClient, proposalId: string) =>
  Effect.gen(function* () {
    const rows = yield* sql`SELECT id, requested_by, proposal, status, expires_at, message_chat_id, message_id
      FROM bot_proposals WHERE id = ${proposalId}`
    const decoded = yield* Schema.decodeUnknownEffect(ProposalRows)(rows).pipe(Effect.orDie)
    return decoded[0]
  })

// Moves a proposal from one status to another in a single conditional write. True only for the caller that made
// the move, so a proposal is decided once even when two confirmations race.
const moveStatus = (
  sql: SqlClient,
  proposalId: string,
  from: ProposalStatus,
  to: ProposalStatus,
  at: number,
) =>
  Effect.gen(function* () {
    const rows = yield* sql`UPDATE bot_proposals SET status = ${to}, decided_at = ${iso(at)}
      WHERE id = ${proposalId} AND status = ${from} RETURNING id`
    return rows.length > 0
  })

// Writes the Bot file, registers it (bot.created by the user). Any failure becomes a `failed` outcome.
const createBot = (deps: BotFactoryDeps, bot: NewBot, userId: string) =>
  Effect.gen(function* () {
    yield* writeBotYaml(deps.botsDir, bot)
    return yield* deps.bots.upsert(bot, `user:${userId}`)
  })

// The buttons of a decided proposal go away; a failed edit is logged (the decision already stands).
const clearButtons = (deps: BotFactoryDeps, row: ProposalRow): Effect.Effect<void> =>
  row.message_chat_id === null || row.message_id === null
    ? Effect.void
    : deps.telegram
        .editReplyMarkup({ chatId: row.message_chat_id, messageId: row.message_id }, null)
        .pipe(Effect.catch((error) => Effect.logWarning("proposal buttons not removed", error.op)))

const confirmed = (
  deps: BotFactoryDeps,
  row: ProposalRow,
  userId: string,
  replyTo: BotId,
  now: number,
): Effect.Effect<ConfirmOutcome, SqlError> =>
  Effect.gen(function* () {
    const stored = decodeStoredBot(row.proposal)
    const requested = Option.isSome(stored) ? stored.value : undefined
    const name =
      requested === undefined
        ? Option.none<string>()
        : yield* freeName(deps.bots, deps.botsDir, requested.name)
    if (requested === undefined || Option.isNone(name)) {
      yield* moveStatus(deps.sql, row.id, "confirmed", "failed", now)
      return yield* answer(deps, replyTo, "failed", refOf(row, "failed"))
    }
    const bot: NewBot = { ...requested, name: name.value }
    const created = yield* createBot(deps, bot, userId).pipe(
      Effect.map((saved) => Option.some(saved)),
      Effect.catch((error) =>
        Effect.logWarning("bot proposal could not be created", error._tag).pipe(Effect.as(Option.none())),
      ),
    )
    if (Option.isNone(created)) {
      yield* moveStatus(deps.sql, row.id, "confirmed", "failed", now)
      return yield* answer(deps, replyTo, "failed", refOf(row, "failed"))
    }
    yield* deps.telegram
      .ensureTopic(created.value)
      .pipe(Effect.catch((error) => Effect.logWarning("bot topic not created yet", error.op)))
    const renamed = name.value !== requested.name
    const text = renamed
      ? `Já existia um Bot com esse nome; criei como ${name.value}. Pronto, fala com ele em #${name.value}.`
      : `pronto, fala com ele em #${name.value}`
    yield* say(deps, replyTo, text)
    return outcomeOf("created", { proposalId: row.id, botName: name.value, status: "confirmed" })
  })

// The decision on a row that exists: each branch is taken once, by the conditional move of its status.
const decide = (
  deps: BotFactoryDeps,
  row: ProposalRow,
  input: { readonly replyTo: BotId; readonly decision: "ok" | "no"; readonly userId: string },
): Effect.Effect<ConfirmOutcome, SqlError> =>
  Effect.gen(function* () {
    if (row.requested_by !== input.userId) {
      return yield* answer(deps, input.replyTo, "not_yours", refOf(row, row.status))
    }
    if (row.status !== "pending") {
      return yield* answer(deps, input.replyTo, "already_decided", refOf(row, row.status))
    }
    const now = yield* Clock.currentTimeMillis
    if (now >= Date.parse(row.expires_at)) {
      const expired = yield* moveStatus(deps.sql, row.id, "pending", "expired", now)
      return expired
        ? yield* answer(deps, input.replyTo, "expired", refOf(row, "expired"))
        : yield* answer(deps, input.replyTo, "already_decided", refOf(row, row.status))
    }
    if (input.decision === "no") {
      const cancelled = yield* moveStatus(deps.sql, row.id, "pending", "cancelled", now)
      return cancelled
        ? yield* answer(deps, input.replyTo, "cancelled", refOf(row, "cancelled"))
        : yield* answer(deps, input.replyTo, "already_decided", refOf(row, row.status))
    }
    // Claimed before anything is written: a second press finds the proposal confirmed and stops here.
    const claimed = yield* moveStatus(deps.sql, row.id, "pending", "confirmed", now)
    if (!claimed) {
      return yield* answer(deps, input.replyTo, "already_decided", refOf(row, row.status))
    }
    return yield* confirmed(deps, row, input.userId, input.replyTo, now)
  })

// A button press or a typed /confirm-bot, from the Renan who asked. A decided proposal loses its buttons.
export const handleConfirmBot = (
  deps: BotFactoryDeps,
  input: {
    readonly replyTo: BotId
    readonly proposalId: string
    readonly decision: "ok" | "no"
    readonly userId: string
  },
): Effect.Effect<ConfirmOutcome, SqlError> =>
  Effect.gen(function* () {
    if (!PROPOSAL_ID.test(input.proposalId)) {
      return yield* answer(deps, input.replyTo, "not_found")
    }
    const row = yield* readProposal(deps.sql, input.proposalId)
    if (row === undefined) {
      return yield* answer(deps, input.replyTo, "not_found")
    }
    const outcome = yield* decide(deps, row, input)
    if (
      outcome.kind === "created" ||
      outcome.kind === "failed" ||
      outcome.kind === "cancelled" ||
      outcome.kind === "expired"
    ) {
      yield* clearButtons(deps, row)
    }
    return outcome
  })
