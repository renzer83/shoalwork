import { createHash } from "node:crypto"
import { lstat, realpath } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { type Bot, TankError, type TankMode } from "@shoalwork/contracts"
import { Effect, Layer, Semaphore } from "effect"
import { ensureClone, worktreeAdd, worktreeList, worktreeRemove, worktreeReuse } from "./git.js"
import { type BotOps, localOps } from "./ops.js"
import { type OwnedWorktree, Tank, type TankContext, type TankShape } from "./tank.js"

// Environment inherited by Bot processes; the caller (core) decides, this package never reads process.env.
export type BaseEnv = Readonly<Record<string, string | undefined>>

export type TankLocalConfig = {
  // <root>/<bot.name>/{home,repos,work}
  readonly root: string
  readonly baseEnv: BaseEnv
  // Explicit values the core passes to every Bot process, applied last (ADR-011: ANTHROPIC_API_KEY is always dropped).
  readonly extraEnv?: Readonly<Record<string, string>>
}

// Where a Tank keeps a Bot's directories and how it runs commands for it. Local and server mode differ only here.
export type TankLayout = {
  readonly mode: TankMode
  // Confinement root for release: nothing outside it is ever deleted.
  readonly root: string
  readonly botDir: (botName: string) => string
  readonly home: (botDir: string) => string
  readonly opsFor: (botName: string) => BotOps
  // Runs before any directory is created for the Bot (server mode: the Linux user must exist).
  readonly preflight: (botName: string) => Effect.Effect<void, TankError>
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

// Confinement to the context cwd, symlinks included. Must run before any read or write.
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

// The only keys a Bot process inherits from the core's base env. Everything else is dropped (R7, ADR-011).
const INHERITED_ENV_KEYS: ReadonlyArray<string> = [
  "PATH",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "TZ",
  "SHELL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
]

// Bots never get an API key from the core, even when extraEnv asks for one.
const DROPPED_EXTRA_KEYS: ReadonlySet<string> = new Set(["ANTHROPIC_API_KEY"])

// Env a Bot process receives: an allowlist of the base env, then extraEnv (minus dropped keys), then the keys the
// Tank always owns (Bot home, CLI config dirs, git safety defaults). Tank keys win over extraEnv.
export const buildBotEnv = (
  baseEnv: BaseEnv,
  home: string,
  extraEnv: Readonly<Record<string, string>> = {},
): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const key of INHERITED_ENV_KEYS) {
    const value = baseEnv[key]
    if (value !== undefined) env[key] = value
  }
  for (const [key, value] of Object.entries(extraEnv)) {
    if (!DROPPED_EXTRA_KEYS.has(key)) env[key] = value
  }
  env.HOME = home
  env.CLAUDE_CONFIG_DIR = join(home, ".claude")
  env.CODEX_HOME = join(home, ".codex")
  env.GEMINI_CLI_HOME = home
  env.GIT_TERMINAL_PROMPT = "0"
  env.GIT_ALLOW_PROTOCOL = "file:git:http:https:ssh"
  return env
}

export const makeBotTank = (
  layout: TankLayout,
  baseEnv: BaseEnv,
  extraEnv: Readonly<Record<string, string>> = {},
): TankShape => {
  // One lock per base clone: concurrent fetch/worktree-add on the same repo race on git's own locks.
  const repoLocks = new Map<string, Semaphore.Semaphore>()
  const lockFor = (repoDir: string): Semaphore.Semaphore => {
    const existing = repoLocks.get(repoDir)
    if (existing !== undefined) return existing
    const created = Semaphore.makeUnsafe(1)
    repoLocks.set(repoDir, created)
    return created
  }

  // Context names come from the caller: validated before they pick the Bot's ops.
  const opsOf = (botName: string): Effect.Effect<BotOps, TankError> =>
    checkSegment("bot name", botName).pipe(Effect.map(() => layout.opsFor(botName)))

  const prepare: TankShape["prepare"] = (bot: Bot, step) =>
    Effect.gen(function* () {
      yield* checkSegment("bot name", bot.name)
      yield* checkSegment("step id", step.stepId)
      yield* layout.preflight(bot.name)
      const ops = layout.opsFor(bot.name)
      const botDir = layout.botDir(bot.name)
      const home = layout.home(botDir)
      const workPath = join(botDir, "work", step.stepId)
      for (const sub of [".claude", ".codex", ".gemini"]) yield* ops.mkdirp(join(home, sub))
      const env = buildBotEnv(baseEnv, home, extraEnv)
      const base = { botId: bot.id, botName: bot.name, home, env }
      if (step.repo === undefined) {
        yield* ops.mkdirp(workPath)
        return { ...base, cwd: workPath }
      }
      const { url, base: baseBranch } = step.repo
      const repoDir = join(botDir, "repos", slugRepoUrl(url))
      const branch = `bot/${bot.name}/${step.stepId}`
      if (step.reuse !== undefined) {
        // Only the worktree this very step owns can be continued: same path and branch the step would create.
        if (step.reuse.path !== workPath || step.reuse.branch !== branch) {
          return yield* Effect.fail(new TankError({ op: "prepare", cause: "reuse does not match the step" }))
        }
        yield* lockFor(repoDir).withPermits(1)(
          worktreeReuse(repoDir, workPath, branch, join(botDir, "work"), env, ops),
        )
        return { ...base, cwd: workPath, worktree: { path: workPath, branch, repoDir } }
      }
      yield* ops.mkdirp(dirname(workPath))
      yield* lockFor(repoDir).withPermits(1)(
        Effect.gen(function* () {
          yield* ensureClone(repoDir, url, baseBranch, env, ops)
          yield* worktreeAdd(repoDir, workPath, branch, baseBranch, env, ops)
        }),
      )
      return { ...base, cwd: workPath, worktree: { path: workPath, branch, repoDir } }
    })

  const release: TankShape["release"] = (ctx, opts) =>
    Effect.gen(function* () {
      if (opts.keepWorktree) return
      // The context is caller-supplied: never delete or run git outside this Bot's own directories.
      yield* checkSegment("bot name", ctx.botName)
      const ops = layout.opsFor(ctx.botName)
      const botDir = layout.botDir(ctx.botName)
      const workDir = join(botDir, "work")
      const reject = (what: string) =>
        Effect.fail(new TankError({ op: "release", cause: `${what} outside the tank root` }))
      if (!isInside(layout.root, ctx.cwd)) return yield* reject("cwd")
      if (ctx.worktree !== undefined) {
        const { repoDir, path, branch } = ctx.worktree
        if (!isInside(join(botDir, "repos"), repoDir) || repoDir === join(botDir, "repos")) {
          return yield* reject("repoDir")
        }
        if (!isInside(workDir, path) || path === workDir) return yield* reject("worktree path")
        yield* lockFor(repoDir).withPermits(1)(worktreeRemove(repoDir, path, branch, ctx.env, ops))
        return
      }
      // No repo: cwd is a plain scratch directory under <root>/<bot>/work/.
      if (!isInside(workDir, ctx.cwd) || ctx.cwd === workDir) return yield* reject("cwd")
      yield* ops.removeTree(ctx.cwd)
    })

  // Only worktrees on the Bot's own branches are reported or removed; the Bot's repo paths are checked as in release.
  const ownRepoDir = (botDir: string, repoDir: string): boolean =>
    isInside(join(botDir, "repos"), repoDir) && repoDir !== join(botDir, "repos")

  const worktrees: TankShape["worktrees"] = (bot, repoUrl) =>
    Effect.gen(function* () {
      yield* checkSegment("bot name", bot.name)
      const ops = layout.opsFor(bot.name)
      const botDir = layout.botDir(bot.name)
      const repoDir = join(botDir, "repos", slugRepoUrl(repoUrl))
      if (!(yield* ops.exists(repoDir))) return []
      const env = buildBotEnv(baseEnv, layout.home(botDir), extraEnv)
      const listed = yield* lockFor(repoDir).withPermits(1)(worktreeList(repoDir, env, ops))
      const prefix = `bot/${bot.name}/`
      const owned: Array<OwnedWorktree> = []
      for (const wt of listed) {
        const branch = wt.branch ?? ""
        if (branch.startsWith(prefix)) owned.push({ repoDir, path: wt.path, branch })
      }
      return owned
    })

  const removeWorktree: TankShape["removeWorktree"] = (bot, wt) =>
    Effect.gen(function* () {
      yield* checkSegment("bot name", bot.name)
      const botDir = layout.botDir(bot.name)
      const workDir = join(botDir, "work")
      const reject = (what: string) =>
        Effect.fail(new TankError({ op: "release", cause: `${what} outside the tank root` }))
      if (!ownRepoDir(botDir, wt.repoDir)) return yield* reject("repoDir")
      if (!isInside(workDir, wt.path) || wt.path === workDir) return yield* reject("worktree path")
      if (!wt.branch.startsWith(`bot/${bot.name}/`)) return yield* reject("branch")
      const ops = layout.opsFor(bot.name)
      const env = buildBotEnv(baseEnv, layout.home(botDir), extraEnv)
      yield* lockFor(wt.repoDir).withPermits(1)(worktreeRemove(wt.repoDir, wt.path, wt.branch, env, ops))
    })

  return {
    mode: layout.mode,
    prepare,
    worktrees,
    removeWorktree,
    exec: (ctx, cmd, opts) =>
      opsOf(ctx.botName).pipe(
        Effect.flatMap((ops) =>
          ops.run(cmd, {
            cwd: ctx.cwd,
            env: ctx.env,
            ...(opts?.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
            ...(opts?.stdin === undefined ? {} : { stdin: opts.stdin }),
          }),
        ),
      ),
    spawnStream: (ctx, cmd) =>
      opsOf(ctx.botName).pipe(Effect.flatMap((ops) => ops.spawn(cmd, { cwd: ctx.cwd, env: ctx.env }))),
    readFile: (ctx, rel) =>
      resolveInside(ctx, rel).pipe(
        Effect.flatMap((p) => opsOf(ctx.botName).pipe(Effect.flatMap((ops) => ops.readText(p)))),
      ),
    writeFile: (ctx, rel, content) =>
      resolveInside(ctx, rel).pipe(
        Effect.flatMap((p) => opsOf(ctx.botName).pipe(Effect.flatMap((ops) => ops.writeText(p, content)))),
      ),
    release,
  }
}

const noPreflight = (): Effect.Effect<void, TankError> => Effect.void

export const makeTankLocal = (config: TankLocalConfig): TankShape => {
  const root = resolve(config.root)
  return makeBotTank(
    {
      mode: "local",
      root,
      botDir: (botName) => join(root, botName),
      home: (botDir) => join(botDir, "home"),
      opsFor: () => localOps,
      preflight: noPreflight,
    },
    config.baseEnv,
    config.extraEnv,
  )
}

export const TankLocalLive = (config: TankLocalConfig): Layer.Layer<Tank> =>
  Layer.succeed(Tank, makeTankLocal(config))
