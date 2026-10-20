import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { TankError } from "@shoalwork/contracts"
import { Effect, type Scope } from "effect"
import { realAncestor } from "./confine.js"
import { type ProcessOptions, type RunOptions, runProcess, spawnProcess } from "./process.js"
import type { ExecResult, RunningProcess } from "./tank.js"

// Env of one call that must never travel in argv. Server mode hands it to sudo through --preserve-env (T-167).
export type PassEnv = { readonly passEnv?: Readonly<Record<string, string>> }

// Everything a Tank does on behalf of one Bot. Local mode runs it directly; server mode runs it as the Bot's
// Linux user (see server.ts). Git helpers and the Tank itself only go through this interface.
export type BotOps = {
  readonly run: (
    cmd: ReadonlyArray<string>,
    opts: RunOptions & PassEnv,
  ) => Effect.Effect<ExecResult, TankError>
  readonly spawn: (
    cmd: ReadonlyArray<string>,
    opts: ProcessOptions & PassEnv,
  ) => Effect.Effect<RunningProcess, TankError, Scope.Scope>
  readonly exists: (path: string) => Effect.Effect<boolean, TankError>
  readonly mkdirp: (path: string) => Effect.Effect<void, TankError>
  readonly removeTree: (path: string) => Effect.Effect<void, TankError>
  readonly readText: (path: string) => Effect.Effect<string, TankError>
  // With a mode the file is created with it (no window at the umask default); an existing file gets it too.
  readonly writeText: (path: string, content: string, mode?: number) => Effect.Effect<void, TankError>
  // Canonical path as this ops' user sees it; a missing tail is kept lexically.
  readonly realpath: (path: string) => Effect.Effect<string, TankError>
}

const fsTry = <A>(op: string, f: () => Promise<A>): Effect.Effect<A, TankError> =>
  Effect.tryPromise({ try: f, catch: (cause) => new TankError({ op, cause }) })

const isEnoent = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT"

const fileExists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    (cause: unknown) => {
      if (isEnoent(cause)) return false
      throw cause
    },
  )

export const localOps: BotOps = {
  run: (cmd, opts) => runProcess(cmd, opts),
  spawn: (cmd, opts) => spawnProcess(cmd, opts),
  exists: (path) => fsTry("stat", () => fileExists(path)),
  mkdirp: (path) =>
    fsTry("mkdir", async () => {
      await mkdir(path, { recursive: true })
    }),
  removeTree: (path) =>
    fsTry("rm", async () => {
      await rm(path, { recursive: true, force: true })
    }),
  readText: (path) => fsTry("readFile", () => readFile(path, "utf8")),
  writeText: (path, content, mode) =>
    fsTry("writeFile", async () => {
      await mkdir(dirname(path), { recursive: true })
      if (mode === undefined) {
        await writeFile(path, content, "utf8")
        return
      }
      const existed = await fileExists(path)
      await writeFile(path, content, { encoding: "utf8", mode })
      if (existed) await chmod(path, mode)
    }),
  realpath: (path) =>
    Effect.tryPromise({
      try: () => realAncestor(path, path),
      catch: (cause) => (cause instanceof TankError ? cause : new TankError({ op: "path", cause })),
    }),
}
