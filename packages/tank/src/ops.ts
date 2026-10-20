import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { TankError } from "@shoalwork/contracts"
import { Effect, type Scope } from "effect"
import { type ProcessOptions, type RunOptions, runProcess, spawnProcess } from "./process.js"
import type { ExecResult, RunningProcess } from "./tank.js"

// Everything a Tank does on behalf of one Bot. Local mode runs it directly; server mode runs it as the Bot's
// Linux user (see server.ts). Git helpers and the Tank itself only go through this interface.
export type BotOps = {
  readonly run: (cmd: ReadonlyArray<string>, opts: RunOptions) => Effect.Effect<ExecResult, TankError>
  readonly spawn: (
    cmd: ReadonlyArray<string>,
    opts: ProcessOptions,
  ) => Effect.Effect<RunningProcess, TankError, Scope.Scope>
  readonly exists: (path: string) => Effect.Effect<boolean, TankError>
  readonly mkdirp: (path: string) => Effect.Effect<void, TankError>
  readonly removeTree: (path: string) => Effect.Effect<void, TankError>
  readonly readText: (path: string) => Effect.Effect<string, TankError>
  readonly writeText: (path: string, content: string) => Effect.Effect<void, TankError>
}

const fsTry = <A>(op: string, f: () => Promise<A>): Effect.Effect<A, TankError> =>
  Effect.tryPromise({ try: f, catch: (cause) => new TankError({ op, cause }) })

const isEnoent = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT"

export const localOps: BotOps = {
  run: (cmd, opts) => runProcess(cmd, opts),
  spawn: (cmd, opts) => spawnProcess(cmd, opts),
  exists: (path) =>
    fsTry("stat", () =>
      stat(path).then(
        () => true,
        (cause: unknown) => {
          if (isEnoent(cause)) return false
          throw cause
        },
      ),
    ),
  mkdirp: (path) =>
    fsTry("mkdir", async () => {
      await mkdir(path, { recursive: true })
    }),
  removeTree: (path) =>
    fsTry("rm", async () => {
      await rm(path, { recursive: true, force: true })
    }),
  readText: (path) => fsTry("readFile", () => readFile(path, "utf8")),
  writeText: (path, content) =>
    fsTry("writeFile", async () => {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content, "utf8")
    }),
}
