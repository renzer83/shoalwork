import { lstat, realpath } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { TankError } from "@shoalwork/contracts"
import { Effect } from "effect"
import type { BotOps } from "./ops.js"

// Names that reach a path or a Linux user: one segment, no separators, no dots.
export const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

export const checkSegment = (what: string, value: string): Effect.Effect<void, TankError> =>
  SEGMENT.test(value)
    ? Effect.void
    : Effect.fail(new TankError({ op: "prepare", cause: `unsafe ${what}: ${JSON.stringify(value)}` }))

export const isInside = (parent: string, child: string): boolean => {
  const rel = relative(parent, child)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

const isEnoent = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT"

export const escapes = (rel: string, why: string): TankError =>
  new TankError({ op: "path", cause: `path escapes the worktree (${why}): ${JSON.stringify(rel)}` })

// Real path of the deepest existing ancestor of `target`; a dangling symlink on the way is rejected
// because writing through it would create a file wherever it points.
export const realAncestor = async (target: string, rel: string): Promise<string> => {
  let current = target
  for (;;) {
    try {
      return await realpath(current)
    } catch (cause) {
      if (!isEnoent(cause)) throw cause
    }
    try {
      await lstat(current)
      throw escapes(rel, "dangling symlink")
    } catch (cause) {
      if (!isEnoent(cause)) throw cause
    }
    const parent = dirname(current)
    if (parent === current) throw escapes(rel, "no existing ancestor")
    current = parent
  }
}

// Confinement to `root`, symlinks included, judged by the ops that will write (so a server Bot is checked as its user).
// Must run before any read or write.
export const resolveUnder = (ops: BotOps, root: string, rel: string): Effect.Effect<string, TankError> =>
  Effect.gen(function* () {
    const target = resolve(root, rel)
    if (!isInside(root, target)) return yield* Effect.fail(escapes(rel, "lexical"))
    const realRoot = yield* ops.realpath(root)
    const realTarget = yield* ops.realpath(target)
    if (!isInside(realRoot, realTarget)) return yield* Effect.fail(escapes(rel, "symlink"))
    return target
  })
