import { SessionId } from "@shoalwork/contracts"
import { Context, Effect, Layer, Option, Schema, Semaphore } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"

// One CLI session per conversation scope ("telegram:<chatId>:<threadId>" or "app:<botId>:<userId>").
const SessionRow = Schema.Struct({ session_id: SessionId })

export class ChatSessions extends Context.Service<
  ChatSessions,
  {
    readonly get: (scope: string) => Effect.Effect<Option.Option<SessionId>, SqlError>
    readonly set: (scope: string, sessionId: SessionId) => Effect.Effect<void, SqlError>
    // Runs `effect` holding the scope's lock: turns of one scope never overlap, different scopes run in parallel.
    readonly withScope: <A, E, R>(scope: string, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  }
>()("@shoalwork/ChatSessions") {}

export const ChatSessionsLive = Layer.effect(
  ChatSessions,
  Effect.gen(function* () {
    const sql = yield* SqlClient
    // One permit per scope. Entries are kept for the life of the process (one per conversation).
    const locks = new Map<string, Semaphore.Semaphore>()
    const lockFor = (scope: string): Semaphore.Semaphore => {
      const existing = locks.get(scope)
      if (existing !== undefined) return existing
      const created = Semaphore.makeUnsafe(1)
      locks.set(scope, created)
      return created
    }
    return {
      get: (scope) =>
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly session_id: string }>`
            SELECT session_id FROM chat_sessions WHERE scope = ${scope}`
          // A malformed row in our own table is a bug, not an expected failure.
          const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(SessionRow))(rows).pipe(Effect.orDie)
          const [first] = decoded
          return first === undefined ? Option.none() : Option.some(first.session_id)
        }),
      set: (scope, sessionId) =>
        sql`
          INSERT INTO chat_sessions (scope, session_id, updated_at)
          VALUES (${scope}, ${sessionId}, ${new Date().toISOString()})
          ON CONFLICT (scope) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at`.pipe(
          Effect.asVoid,
        ),
      withScope: (scope, effect) => Semaphore.withPermit(lockFor(scope))(effect),
    }
  }),
)
