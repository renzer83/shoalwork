import { type SpawnOptions, spawn } from "node:child_process"
import type { EventEmitter } from "node:events"
import { existsSync } from "node:fs"
import type { SidecarName, SidecarState } from "@shoalwork/contracts"
import { Effect, type Scope } from "effect"

// What the supervisor needs from a child: its pid (group kill) and its exit.
export type ChildHandle = Pick<EventEmitter, "once"> & { readonly pid?: number | undefined }
export type SpawnProcess = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => ChildHandle

export const defaultSpawnProcess: SpawnProcess = (command, args, options) =>
  spawn(command, [...args], options)

export type SidecarSpec = {
  readonly name: SidecarName
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly healthUrl: string
  // Checked before the first spawn: a missing file means "unavailable", not a crash loop.
  readonly requiredFiles: ReadonlyArray<string>
}

export type SupervisorOptions = {
  readonly healthIntervalMs: number
  readonly startupTimeoutMs: number
  readonly restartWindowMs: number
  // Crashes inside the window that are still restarted: the next one gives up.
  readonly maxRestarts: number
  readonly backoffMs: number
  readonly probeTimeoutMs: number
  readonly spawnProcess: SpawnProcess
}

export const DEFAULT_SUPERVISOR: SupervisorOptions = {
  healthIntervalMs: 30_000,
  startupTimeoutMs: 60_000,
  restartWindowMs: 300_000,
  maxRestarts: 3,
  backoffMs: 1_000,
  probeTimeoutMs: 2_000,
  spawnProcess: defaultSpawnProcess,
}

export type SidecarStatus = {
  readonly state: SidecarState
  readonly restarts: number
  readonly reason?: string | undefined
}

export type StatusReport = (status: SidecarStatus) => Effect.Effect<void>

// Same kill order as the Tank: SIGTERM to the group, SIGKILL after the grace period.
const KILL_GRACE_MS = 5_000

const signalGroup = (pid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pid, signal)
  } catch (cause) {
    // ESRCH: the group is already gone, which is the goal.
    if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) throw cause
  }
}

// One probe: any 2xx within the timeout is healthy. Errors are a `false`, not a failure.
export const probe = (url: string, timeoutMs: number): Effect.Effect<boolean> =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) })
      return response.ok
    },
    catch: () => false,
  }).pipe(Effect.orElseSucceed(() => false))

const sleep = (ms: number): Effect.Effect<void> => Effect.sleep(ms)

type Child = {
  readonly pid: number | undefined
  readonly exited: Effect.Effect<number | null>
  readonly hasExited: Effect.Effect<boolean>
}

// The child lives as long as the scope: closing the scope kills its process group.
const spawnChild = (
  spec: SidecarSpec,
  options: SupervisorOptions,
): Effect.Effect<Child, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync((): Child => {
      const handle = options.spawnProcess(spec.command, spec.args, {
        cwd: spec.cwd,
        env: { ...spec.env },
        detached: true,
        stdio: ["ignore", "inherit", "inherit"],
      })
      // Listeners are attached now, not when the Effect runs: a child that exits first must not be missed.
      let exitedWith: { readonly code: number | null } | undefined
      const exitedPromise = new Promise<number | null>((resolve) => {
        const finish = (code: number | null) => {
          exitedWith = { code }
          resolve(code)
        }
        handle.once("error", () => finish(null))
        handle.once("close", (code: number | null) => finish(code))
      })
      return {
        pid: handle.pid,
        exited: Effect.promise(() => exitedPromise),
        hasExited: Effect.sync(() => exitedWith !== undefined),
      }
    }),
    (child) =>
      Effect.sync(() => {
        if (child.pid !== undefined) signalGroup(child.pid, "SIGTERM")
      }).pipe(
        Effect.andThen(
          child.exited.pipe(
            Effect.timeoutOrElse({
              duration: KILL_GRACE_MS,
              orElse: () =>
                Effect.sync(() => {
                  if (child.pid !== undefined) signalGroup(child.pid, "SIGKILL")
                }).pipe(Effect.andThen(child.exited)),
            }),
          ),
        ),
        Effect.asVoid,
      ),
  )

// Waits for the first healthy probe, up to the startup timeout. Stops early when the child exits (a crash at
// startup must not cost the whole timeout). Returns whether it became healthy.
const waitHealthy = (url: string, options: SupervisorOptions, child: Child): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const deadline = Date.now() + options.startupTimeoutMs
    while (Date.now() < deadline) {
      if (yield* probe(url, options.probeTimeoutMs)) return true
      if (yield* child.hasExited) return false
      yield* sleep(500)
    }
    return false
  })

// One life of a child: spawn, wait for health, then keep probing every interval until it exits.
// Returns the exit code of that life.
const runOnce = (
  spec: SidecarSpec,
  options: SupervisorOptions,
  report: StatusReport,
  restarts: number,
): Effect.Effect<number | null> =>
  Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawnChild(spec, options)
      const healthy = yield* waitHealthy(spec.healthUrl, options, child)
      if (!healthy && (yield* child.hasExited)) return yield* child.exited
      yield* report({
        state: healthy ? "ready" : "starting",
        restarts,
        reason: healthy ? undefined : "no health response yet",
      })
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* () {
            yield* sleep(options.healthIntervalMs)
            const ok = yield* probe(spec.healthUrl, options.probeTimeoutMs)
            yield* report({
              state: ok ? "ready" : "unavailable",
              restarts,
              reason: ok ? undefined : "health probe failed",
            })
          }),
        ),
      )
      return yield* child.exited
    }),
  )

// Restarts the sidecar after each crash, up to `maxRestarts` crashes in `restartWindowMs`. Never fails:
// a sidecar that gives up is reported as unavailable, and the voice service keeps running without it.
export const superviseSidecar = (
  spec: SidecarSpec,
  options: SupervisorOptions,
  report: StatusReport,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const missing = spec.requiredFiles.filter((file) => !existsSync(file))
    if (missing.length > 0) {
      yield* report({ state: "unavailable", restarts: 0, reason: "required file missing" })
      return
    }
    const crashes: number[] = []
    let restarts = 0
    while (true) {
      const code = yield* runOnce(spec, options, report, restarts)
      const now = Date.now()
      crashes.push(now)
      const inWindow = crashes.filter((at) => now - at <= options.restartWindowMs)
      crashes.splice(0, crashes.length, ...inWindow)
      if (inWindow.length > options.maxRestarts) {
        yield* report({
          state: "unavailable",
          restarts,
          reason: `gave up after ${inWindow.length} crashes in the window (last exit ${code ?? "none"})`,
        })
        return
      }
      restarts += 1
      yield* report({ state: "restarting", restarts, reason: `exited with ${code ?? "none"}` })
      yield* sleep(options.backoffMs)
    }
  })
