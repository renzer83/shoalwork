import { createHash } from "node:crypto"
import { dirname, join, resolve } from "node:path"
import { type Bot, TankError, type TankMode } from "@shoalwork/contracts"
import { Effect, Layer, Semaphore } from "effect"
import { checkSegment, escapes, isInside, resolveUnder } from "./confine.js"
import { type BaseEnv, buildBotEnv, STEP_ENV_PATTERN } from "./env.js"
import { ensureClone, worktreeAdd, worktreeList, worktreeRemove, worktreeReuse } from "./git.js"
import { type BotOps, localOps } from "./ops.js"
import { type OwnedWorktree, Tank, type TankShape } from "./tank.js"

export { type BaseEnv, buildBotEnv } from "./env.js"

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

// Keys of one execution's env (T-167): only SHOALWORK_* names, checked before anything is created.
const checkStepEnv = (
  extra: Readonly<Record<string, string>> = {},
): Effect.Effect<Record<string, string>, TankError> => {
  const bad = Object.keys(extra).find((key) => !STEP_ENV_PATTERN.test(key))
  return bad === undefined
    ? Effect.succeed({ ...extra })
    : Effect.fail(new TankError({ op: "prepare", cause: `step env key not allowed: ${JSON.stringify(bad)}` }))
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

  // Git runs with the Bot env but without the execution's env: its secrets never reach a git argv.
  const prepare: TankShape["prepare"] = (bot: Bot, step) =>
    Effect.gen(function* () {
      yield* checkSegment("bot name", bot.name)
      yield* checkSegment("step id", step.stepId)
      const stepEnv = yield* checkStepEnv(step.extraEnv)
      yield* layout.preflight(bot.name)
      const ops = layout.opsFor(bot.name)
      const botDir = layout.botDir(bot.name)
      const home = layout.home(botDir)
      const workPath = join(botDir, "work", step.stepId)
      for (const sub of [".claude", ".codex", ".gemini"]) yield* ops.mkdirp(join(home, sub))
      const env = buildBotEnv(baseEnv, home, extraEnv)
      const base = {
        botId: bot.id,
        botName: bot.name,
        home,
        env: buildBotEnv(baseEnv, home, { ...extraEnv, ...stepEnv }),
        stepEnv,
      }
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
      const gitEnv = buildBotEnv(baseEnv, layout.home(botDir), extraEnv)
      if (ctx.worktree !== undefined) {
        const { repoDir, path, branch } = ctx.worktree
        if (!isInside(join(botDir, "repos"), repoDir) || repoDir === join(botDir, "repos")) {
          return yield* reject("repoDir")
        }
        if (!isInside(workDir, path) || path === workDir) return yield* reject("worktree path")
        yield* lockFor(repoDir).withPermits(1)(worktreeRemove(repoDir, path, branch, gitEnv, ops))
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

  // Home files: confined to the Bot's home (symlinks included), created with the mode in one step.
  const writeHomeFile: TankShape["writeHomeFile"] = (ctx, rel, content, mode) =>
    Effect.gen(function* () {
      const ops = yield* opsOf(ctx.botName)
      const botDir = layout.botDir(ctx.botName)
      if (!isInside(botDir, ctx.home)) {
        return yield* Effect.fail(
          new TankError({ op: "writeHomeFile", cause: "home outside the bot directory" }),
        )
      }
      if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
        return yield* Effect.fail(new TankError({ op: "writeHomeFile", cause: `invalid mode: ${mode}` }))
      }
      if (resolve(ctx.home, rel) === resolve(ctx.home)) {
        return yield* Effect.fail(escapes(rel, "home itself"))
      }
      // The home must also be inside the Bot directory once symlinks are followed (fail closed).
      const realBotDir = yield* ops.realpath(botDir)
      const realHome = yield* ops.realpath(ctx.home)
      if (!isInside(realBotDir, realHome)) {
        return yield* Effect.fail(
          new TankError({ op: "writeHomeFile", cause: "home outside the bot directory" }),
        )
      }
      const target = yield* resolveUnder(ops, ctx.home, rel)
      yield* ops.writeText(target, content, mode)
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
            passEnv: ctx.stepEnv ?? {},
            ...(opts?.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
            ...(opts?.stdin === undefined ? {} : { stdin: opts.stdin }),
          }),
        ),
      ),
    spawnStream: (ctx, cmd) =>
      opsOf(ctx.botName).pipe(
        Effect.flatMap((ops) => ops.spawn(cmd, { cwd: ctx.cwd, env: ctx.env, passEnv: ctx.stepEnv ?? {} })),
      ),
    readFile: (ctx, rel) =>
      Effect.gen(function* () {
        const ops = yield* opsOf(ctx.botName)
        const p = yield* resolveUnder(ops, ctx.cwd, rel)
        return yield* ops.readText(p)
      }),
    writeFile: (ctx, rel, content) =>
      Effect.gen(function* () {
        const ops = yield* opsOf(ctx.botName)
        const p = yield* resolveUnder(ops, ctx.cwd, rel)
        yield* ops.writeText(p, content)
      }),
    writeHomeFile,
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
