import type { ExecutorEvent, ExecutorTask } from "@shoalwork/contracts"
import { type RunningProcess, Tank, type TankContext } from "@shoalwork/tank"
import { type Cause, Duration, Effect, Exit, Option, Queue, Schema, Scope, Semaphore, Stream } from "effect"
import { captureStderr } from "../stderr.js"
import { buildWarmChatArgs, encodeWarmUserMessage } from "./args.js"
import { CHAT_ID } from "./chat.js"
import { dropApiKey } from "./env.js"
import { ClaudeStreamLine, makeMapperState, toExecutorEvents } from "./events.js"

export type WarmChatPoolOptions = {
  readonly bin?: string
  readonly envOverrides?: Readonly<Record<string, string>>
  // A process with no message for this long is stopped (default 10 min).
  readonly idleMs?: number
  // Live processes at most (default 8). At the limit the oldest idle one is stopped to make room.
  readonly maxProcesses?: number
  // Wall-clock cap for one turn (default 20 s, like the one-shot chat). runChatTurn shares it with the fallback.
  readonly timeoutMs?: number
  // How often idle processes are looked for (default: a quarter of idleMs, at most 30 s).
  readonly sweepMs?: number
}

// What a warm turn produced. `unavailable` means no warm process could answer (spawn failed, the process died,
// the output could not be mapped, the pool is closed, or it is full of busy processes): the caller answers with the
// one-shot chat.
export type WarmTurnOutcome =
  | { readonly kind: "events"; readonly events: ReadonlyArray<ExecutorEvent> }
  | { readonly kind: "timeout"; readonly timeoutMs: number }
  | { readonly kind: "unavailable" }

export type WarmChatPool = {
  // Runs one turn of `scopeKey` on its process, spawning it when needed. Turns of one key are serialized here too.
  // A turn that is interrupted after its message was written discards the process (a late answer would be read by
  // the next turn).
  readonly turn: (scopeKey: string, task: ExecutorTask, ctx: TankContext) => Effect.Effect<WarmTurnOutcome>
  // Live processes right now.
  readonly size: Effect.Effect<number>
  // The per-turn budget, for callers that fall back to another path within the same budget.
  readonly timeoutMs: number
}

const DEFAULT_IDLE_MS = 600_000
const DEFAULT_MAX_PROCESSES = 8
const DEFAULT_TIMEOUT_MS = 20_000
const MAX_SWEEP_MS = 30_000

type Entry = {
  readonly key: string
  readonly proc: RunningProcess
  readonly scope: Scope.Closeable
  // stdout lines; ends (Done) when the process closes its stdout.
  readonly lines: Queue.Queue<string, Cause.Done>
  readonly stderrTail: Effect.Effect<string>
  lastUsed: number
  // 1 while a turn runs on it; the sweep and the eviction never stop an entry with users.
  users: number
  dead: boolean
}

const decodeLine = Schema.decodeUnknownOption(ClaudeStreamLine)

const parseLine = (raw: string): Option.Option<ClaudeStreamLine> => {
  try {
    const value: unknown = JSON.parse(raw)
    return decodeLine(value)
  } catch {
    return Option.none()
  }
}

type Read =
  | { readonly kind: "result"; readonly events: ReadonlyArray<ExecutorEvent> }
  | { readonly kind: "ended" }
  | { readonly kind: "protocol" }

const UNAVAILABLE: WarmTurnOutcome = { kind: "unavailable" }

// Reads lines until the `result` of this turn. Everything before it (init, assistant, rate_limit_event) is mapped
// with a fresh mapper state, since each turn starts with its own `system/init`.
const readTurn = (entry: Entry): Effect.Effect<Read> =>
  Effect.gen(function* () {
    const state = makeMapperState(CHAT_ID)
    const events: Array<ExecutorEvent> = []
    while (true) {
      const next = yield* Effect.exit(Queue.take(entry.lines))
      if (!Exit.isSuccess(next)) return { kind: "ended" }
      const line = parseLine(next.value)
      if (Option.isNone(line)) continue
      const mapped = yield* toExecutorEvents(line.value, state).pipe(
        Effect.catchTag("ExecutorProtocolError", () => Effect.succeed(undefined)),
      )
      if (mapped === undefined) return { kind: "protocol" }
      events.push(...mapped)
      if (line.value.type === "result") return { kind: "result", events }
    }
  })

export const makeWarmChatPool = (
  opts: WarmChatPoolOptions = {},
): Effect.Effect<WarmChatPool, never, Tank | Scope.Scope> =>
  Effect.gen(function* () {
    const tank = yield* Tank
    const poolScope = yield* Effect.scope
    const bin = opts.bin ?? "claude"
    const envOverrides = dropApiKey(opts.envOverrides ?? {})
    const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS
    const maxProcesses = opts.maxProcesses ?? DEFAULT_MAX_PROCESSES
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const sweepMs = opts.sweepMs ?? Math.max(5, Math.min(MAX_SWEEP_MS, Math.floor(idleMs / 4)))

    const entries = new Map<string, Entry>()
    // Entries already out of the map whose process is still being stopped; the pool finalizer finishes them.
    const closing = new Set<Entry>()
    // One lock per key, independent of the entry, so turns of a key stay serialized when its process is replaced.
    // Entries are kept for the life of the pool (one per conversation).
    const keyLocks = new Map<string, Semaphore.Semaphore>()
    const lockFor = (key: string): Semaphore.Semaphore => {
      const existing = keyLocks.get(key)
      if (existing !== undefined) return existing
      const created = Semaphore.makeUnsafe(1)
      keyLocks.set(key, created)
      return created
    }
    // Guards the map and process creation, so two callers never spawn twice for one key. Never held while a
    // process is being stopped.
    const mapLock = Semaphore.makeUnsafe(1)
    let closed = false

    // Takes the entry out of the map and marks it dead; the process is stopped by `dispose`.
    const retire = (entry: Entry): void => {
      entry.dead = true
      if (entries.get(entry.key) === entry) entries.delete(entry.key)
      closing.add(entry)
    }

    // Closing the entry scope stops the process group (SIGTERM, SIGKILL after the grace) and the reader fibers.
    const dispose = (entry: Entry): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* entry.proc.closeStdin()
        yield* Scope.close(entry.scope, Exit.void)
        closing.delete(entry)
      })

    const discard = (entry: Entry): Effect.Effect<void> =>
      Effect.suspend(() => {
        retire(entry)
        return dispose(entry)
      })

    const disposeAll = (victims: ReadonlyArray<Entry>): Effect.Effect<void> =>
      Effect.forEach(victims, dispose, { concurrency: "unbounded", discard: true })

    // Spawns the process and registers it in the map. Runs under the map lock inside an uninterruptible acquire, so
    // a process is never left running without an owner.
    const spawn = (key: string, task: ExecutorTask, ctx: TankContext): Effect.Effect<Option.Option<Entry>> =>
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const env = dropApiKey({ ...ctx.env, ...envOverrides })
        const spawned = yield* Effect.exit(
          tank.spawnStream({ ...ctx, env }, [bin, ...buildWarmChatArgs(task)]).pipe(Scope.provide(scope)),
        )
        if (!Exit.isSuccess(spawned)) {
          yield* Effect.logWarning("warm chat process could not be spawned; using the one-shot chat")
          yield* Scope.close(scope, Exit.void)
          return Option.none()
        }
        const proc = spawned.value
        const lines = yield* Queue.unbounded<string, Cause.Done>()
        const stderrTail = yield* captureStderr(proc.stderr).pipe(Scope.provide(scope))
        const entry: Entry = {
          key,
          proc,
          scope,
          lines,
          stderrTail,
          lastUsed: Date.now(),
          users: 1,
          dead: false,
        }
        entries.set(key, entry)
        // The reader outlives single turns: it feeds `lines` until the process closes stdout.
        yield* proc.stdout.pipe(
          Stream.runForEach((line) => Queue.offer(lines, line)),
          Effect.catchCause(() => Effect.void),
          Effect.ensuring(
            Effect.suspend(() => {
              entry.dead = true
              return Queue.end(lines)
            }),
          ),
          Effect.forkIn(scope),
        )
        return Option.some(entry)
      })

    // Finds or creates the entry for `key` and registers the caller as its user. Processes that have to go (dead
    // entry of this key, oldest idle one at the limit) are taken out under the lock and stopped after it.
    const acquire = (
      key: string,
      task: ExecutorTask,
      ctx: TankContext,
    ): Effect.Effect<Option.Option<Entry>> =>
      Effect.gen(function* () {
        const victims: Array<Entry> = []
        const acquired = yield* Semaphore.withPermit(
          mapLock,
          Effect.gen(function* () {
            if (closed) return Option.none<Entry>()
            const existing = entries.get(key)
            if (existing !== undefined && !existing.dead) {
              existing.users += 1
              return Option.some(existing)
            }
            // The process of this key died while idle: drop it and start a new one (resuming the stored session).
            if (existing !== undefined) {
              retire(existing)
              victims.push(existing)
            }
            if (entries.size >= maxProcesses) {
              const idle = [...entries.values()]
                .filter((candidate) => candidate.users === 0)
                .sort((a, b) => a.lastUsed - b.lastUsed)[0]
              if (idle === undefined) return Option.none<Entry>()
              retire(idle)
              victims.push(idle)
            }
            return yield* spawn(key, task, ctx)
          }),
        )
        yield* disposeAll(victims)
        return acquired
      })

    const release = (acquired: Option.Option<Entry>): Effect.Effect<void> =>
      Effect.sync(() => {
        if (Option.isNone(acquired)) return
        acquired.value.users -= 1
        acquired.value.lastUsed = Date.now()
      })

    const runOnEntry = (entry: Entry, task: ExecutorTask): Effect.Effect<WarmTurnOutcome> =>
      Effect.gen(function* () {
        if (entry.dead) {
          yield* discard(entry)
          return UNAVAILABLE
        }
        // Anything printed since the last result is not an answer to this message.
        yield* Queue.clear(entry.lines)
        const started = Date.now()
        // Interrupted after the message went out: the answer would still arrive and be taken for the next turn's,
        // so the process is discarded.
        const read = yield* entry.proc.writeStdin(encodeWarmUserMessage(task.prompt)).pipe(
          Effect.andThen(readTurn(entry).pipe(Effect.timeoutOption(Duration.millis(timeoutMs)))),
          Effect.onInterrupt(() => discard(entry)),
        )
        if (Option.isNone(read)) {
          yield* discard(entry)
          return { kind: "timeout", timeoutMs }
        }
        if (read.value.kind !== "result") {
          const tail = yield* entry.stderrTail
          yield* Effect.logWarning(
            `warm chat process ${read.value.kind === "ended" ? "ended" : "sent an unmappable line"} mid-turn${tail === "" ? "" : `; stderr: ${tail}`}`,
          )
          yield* discard(entry)
          return UNAVAILABLE
        }
        // Wall-clock of this turn, like the one-shot chat (the CLI's duration_ms leaves out process work).
        const seconds = Math.round((Date.now() - started) / 1000)
        const events = read.value.events.map(
          (event): ExecutorEvent =>
            event.kind === "usage" ? { kind: "usage", usage: { ...event.usage, seconds } } : event,
        )
        return { kind: "events", events }
      })

    const turn: WarmChatPool["turn"] = (key, task, ctx) =>
      Semaphore.withPermit(
        lockFor(key),
        Effect.acquireUseRelease(
          acquire(key, task, ctx),
          (acquired): Effect.Effect<WarmTurnOutcome> =>
            Option.isNone(acquired) ? Effect.succeed(UNAVAILABLE) : runOnEntry(acquired.value, task),
          release,
        ),
      )

    const sweep = Effect.gen(function* () {
      const victims = yield* Semaphore.withPermit(
        mapLock,
        Effect.sync(() => {
          const now = Date.now()
          const picked = [...entries.values()].filter(
            (entry) => entry.users === 0 && (entry.dead || now - entry.lastUsed >= idleMs),
          )
          for (const entry of picked) retire(entry)
          return picked
        }),
      )
      yield* disposeAll(victims)
    })

    yield* Effect.forever(Effect.sleep(Duration.millis(sweepMs)).pipe(Effect.andThen(sweep))).pipe(
      Effect.forkIn(poolScope),
    )

    // Closing the pool's scope stops every process, also those a sweep or an eviction was still stopping: no orphans.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const all = yield* Semaphore.withPermit(
          mapLock,
          Effect.sync(() => {
            closed = true
            const remaining = [...entries.values()]
            for (const entry of remaining) retire(entry)
            return [...closing]
          }),
        )
        yield* disposeAll(all)
      }),
    )

    return { turn, size: Effect.sync(() => entries.size), timeoutMs }
  })
