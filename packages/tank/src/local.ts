import { createHash } from "node:crypto"
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { type Bot, TankError } from "@shoalwork/contracts"
import { Effect, Layer, Semaphore } from "effect"
import { ensureClone, worktreeAdd, worktreeRemove } from "./git.js"
import { runProcess, spawnProcess } from "./process.js"
import { Tank, type TankContext, type TankShape } from "./tank.js"

export type TankLocalConfig = {
  // <root>/<bot.name>/{home,repos,work}
  readonly root: string
  // Environment inherited by Bot processes; the caller (core) decides, this package never reads process.env.
  readonly baseEnv: Readonly<Record<string, string | undefined>>
}

// Filesystem-safe name for a repo URL; the hash keeps distinct URLs from colliding after slugging.
export const slugRepoUrl = (url: string): string => {
  const readable = url
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(-60)
    .replace(/^-+/, "")
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 8)
  return readable === "" ? hash : `${readable}-${hash}`
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

const checkSegment = (what: string, value: string): Effect.Effect<void, TankError> =>
  SEGMENT.test(value)
    ? Effect.void
    : Effect.fail(new TankError({ op: "prepare", cause: `unsafe ${what}: ${JSON.stringify(value)}` }))

const fsTry = <A>(op: string, f: () => Promise<A>): Effect.Effect<A, TankError> =>
  Effect.tryPromise({ try: f, catch: (cause) => new TankError({ op, cause }) })

const isInside = (parent: string, child: string): boolean => {
  const rel = relative(parent, child)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

const isEnoent = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT"

const escapes = (rel: string, why: string): TankError =>
  new TankError({ op: "path", cause: `path escapes the worktree (${why}): ${JSON.stringify(rel)}` })

// Real path of the deepest existing ancestor of `target`; a dangling symlink on the way is rejected
// because writing through it would create a file wherever it points.
const realAncestor = async (target: string, rel: string): Promise<string> => {
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

// Confinement to the context cwd, symlinks included. Must run before any mkdir/write.
const resolveInside = (ctx: TankContext, rel: string): Effect.Effect<string, TankError> =>
  Effect.tryPromise({
    try: async () => {
      const target = resolve(ctx.cwd, rel)
      if (!isInside(ctx.cwd, target)) throw escapes(rel, "lexical")
      const [realCwd, realTarget] = await Promise.all([realpath(ctx.cwd), realAncestor(target, rel)])
      if (!isInside(realCwd, realTarget)) throw escapes(rel, "symlink")
      return target
    },
    catch: (cause) => (cause instanceof TankError ? cause : new TankError({ op: "path", cause })),
  })

export const makeTankLocal = (config: TankLocalConfig): TankShape => {
  const root = resolve(config.root)
  // One lock per base clone: concurrent fetch/worktree-add on the same repo race on git's own locks.
  const repoLocks = new Map<string, Semaphore.Semaphore>()
  const lockFor = (repoDir: string): Semaphore.Semaphore => {
    const existing = repoLocks.get(repoDir)
    if (existing !== undefined) return existing
    const created = Semaphore.makeUnsafe(1)
    repoLocks.set(repoDir, created)
    return created
  }

  const buildEnv = (home: string): Record<string, string> => {
    const merged: Record<string, string | undefined> = {
      ...config.baseEnv,
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      CODEX_HOME: join(home, ".codex"),
      GEMINI_CLI_HOME: home,
      // Bots authenticate through their own CLI login (CLAUDE_CONFIG_DIR); host credentials must not win.
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_AUTH_TOKEN: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
    }
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(merged)) if (value !== undefined) env[key] = value
    return env
  }

  const prepare: TankShape["prepare"] = (bot: Bot, step) =>
    Effect.gen(function* () {
      yield* checkSegment("bot name", bot.name)
      yield* checkSegment("step id", step.stepId)
      const botDir = join(root, bot.name)
      const home = join(botDir, "home")
      const workPath = join(botDir, "work", step.stepId)
      yield* fsTry("mkdir home", async () => {
        for (const sub of [".claude", ".codex", ".gemini"]) await mkdir(join(home, sub), { recursive: true })
      })
      const env = buildEnv(home)
      const base = { botId: bot.id, botName: bot.name, home, env }
      if (step.repo === undefined) {
        yield* fsTry("mkdir work", () => mkdir(workPath, { recursive: true }))
        return { ...base, cwd: workPath }
      }
      const { url, base: baseBranch } = step.repo
      const repoDir = join(botDir, "repos", slugRepoUrl(url))
      const branch = `bot/${bot.name}/${step.stepId}`
      yield* fsTry("mkdir work", () => mkdir(dirname(workPath), { recursive: true }))
      yield* lockFor(repoDir).withPermits(1)(
        Effect.gen(function* () {
          yield* ensureClone(repoDir, url, baseBranch, env)
          yield* worktreeAdd(repoDir, workPath, branch, baseBranch, env)
        }),
      )
      return { ...base, cwd: workPath, worktree: { path: workPath, branch, repoDir } }
    })

  const release: TankShape["release"] = (ctx, opts) =>
    Effect.gen(function* () {
      if (opts.keepWorktree) return
      // The context is caller-supplied: never delete or run git outside this Bot's own directories.
      yield* checkSegment("bot name", ctx.botName)
      const botDir = join(root, ctx.botName)
      const workDir = join(botDir, "work")
      const reject = (what: string) =>
        Effect.fail(new TankError({ op: "release", cause: `${what} outside the tank root` }))
      if (!isInside(root, ctx.cwd)) return yield* reject("cwd")
      if (ctx.worktree !== undefined) {
        const { repoDir, path, branch } = ctx.worktree
        if (!isInside(join(botDir, "repos"), repoDir) || repoDir === join(botDir, "repos")) {
          return yield* reject("repoDir")
        }
        if (!isInside(workDir, path) || path === workDir) return yield* reject("worktree path")
        yield* lockFor(repoDir).withPermits(1)(worktreeRemove(repoDir, path, branch, ctx.env))
        return
      }
      // No repo: cwd is a plain scratch directory under <root>/<bot>/work/.
      if (!isInside(workDir, ctx.cwd) || ctx.cwd === workDir) return yield* reject("cwd")
      yield* fsTry("rm work", () => rm(ctx.cwd, { recursive: true, force: true }))
    })

  return {
    mode: "local",
    prepare,
    exec: (ctx, cmd, opts) =>
      runProcess(cmd, {
        cwd: ctx.cwd,
        env: ctx.env,
        ...(opts?.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
        ...(opts?.stdin === undefined ? {} : { stdin: opts.stdin }),
      }),
    spawnStream: (ctx, cmd) => spawnProcess(cmd, { cwd: ctx.cwd, env: ctx.env }),
    readFile: (ctx, rel) =>
      resolveInside(ctx, rel).pipe(Effect.flatMap((p) => fsTry("readFile", () => readFile(p, "utf8")))),
    writeFile: (ctx, rel, content) =>
      resolveInside(ctx, rel).pipe(
        Effect.flatMap((p) =>
          fsTry("writeFile", async () => {
            await mkdir(dirname(p), { recursive: true })
            await writeFile(p, content, "utf8")
          }),
        ),
      ),
    release,
  }
}

export const TankLocalLive = (config: TankLocalConfig): Layer.Layer<Tank> =>
  Layer.succeed(Tank, makeTankLocal(config))
