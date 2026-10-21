import type { Bot, RepoRef, TankError, TaskSpec } from "@shoalwork/contracts"
import {
  activeFilesFromText,
  type CodeSearchHit,
  DEFAULT_MAX_FILE_BYTES,
  type DocHit,
  type GitIntelError,
  isIgnoredPath,
  looksLikeSecret,
  type RankedCode,
  type RecentCommit,
  type ReefShape,
  type RelatedDiff,
  recentChanges,
  relatedDiffs,
  type Scored,
  taskSymbols,
} from "@shoalwork/reef"
import type { TankContext, TankShape } from "@shoalwork/tank"
import { Cause, Effect } from "effect"
import { assemble, type Block } from "./assemble.js"
import {
  acceptanceBlock,
  codeBlock,
  docsBlock,
  gitBlock,
  handoffBlock,
  instructionsBlock,
  memoryBlock,
  rulesBlock,
  taskBlock,
  workingBlock,
} from "./blocks.js"
import type { ContextConfig } from "./config.js"
import type { ContextLevel, ContextPlan } from "./planner.js"
import { isAbsent, readRuleItems } from "./rules.js"

// Only what the memory search needs: the Reef's search, so tests can answer with a fixture.
export type BriefingMemory = Pick<ReefShape, "search">

// The markdown that names the symbols of a task: the repo index's docs search (T-099).
export type BriefingDocs = (
  repo: RepoRef,
  symbols: ReadonlyArray<string>,
) => Effect.Effect<ReadonlyArray<DocHit>, unknown>

// A briefing source that can fail on its own and is reported without failing the run.
type BriefingSource = "memory" | "code" | "rules" | "git" | "docs"

// The history block: the week's commits to the task's files and the diffs of the latest of them (T-099).
const GIT_WINDOW_DAYS = 7
const GIT_PATHS_MAX = 5
const GIT_DIFF_LINES = 120
const GIT_DIFFS_MAX = 2
// Files of the task read for the exported names the docs search looks for.
const SYMBOL_FILES_MAX = 5

interface History {
  readonly commits: ReadonlyArray<RecentCommit>
  readonly diffs: ReadonlyArray<RelatedDiff>
}
const NO_HISTORY: History = { commits: [], diffs: [] }

// The week's commits that touched `paths` and the diffs of the newest of them, read from the task's worktree.
const historyOf = (repoDir: string, paths: ReadonlyArray<string>): Effect.Effect<History, GitIntelError> =>
  Effect.gen(function* () {
    const scope = paths.slice(0, GIT_PATHS_MAX)
    const commits = yield* recentChanges(repoDir, scope, GIT_WINDOW_DAYS)
    if (commits.length === 0) return NO_HISTORY
    // Position of each commit in the window (newest first): the diffs shown are those of the latest commits.
    const position = new Map(commits.map((commit, index) => [commit.sha, index] as const))
    const diffs = (yield* relatedDiffs(repoDir, scope, GIT_DIFF_LINES))
      .filter((diff) => position.has(diff.sha))
      .sort((a, b) => (position.get(a.sha) ?? 0) - (position.get(b.sha) ?? 0))
      .slice(0, GIT_DIFFS_MAX)
    return { commits, diffs }
  })

// The task's files whose exported names count as symbols. Ignored and secret-looking files are never read; a file
// that is not there is skipped, any other failure to read is the caller's to report.
const symbolFiles = (
  tank: Pick<TankShape, "readFile">,
  ctx: TankContext,
  paths: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<{ readonly path: string; readonly content: string }>, TankError> =>
  Effect.forEach(
    paths.filter((path) => !isIgnoredPath(path)).slice(0, SYMBOL_FILES_MAX),
    (path) =>
      tank.readFile(ctx, path).pipe(
        Effect.map((content) =>
          content.length <= DEFAULT_MAX_FILE_BYTES && !looksLikeSecret(content)
            ? { path, content }
            : undefined,
        ),
        Effect.catch((error: TankError) =>
          isAbsent(error) ? Effect.succeed(undefined) : Effect.fail(error),
        ),
      ),
    { concurrency: 1 },
  ).pipe(Effect.map((files) => files.filter((file) => file !== undefined)))

// The documentation of the symbols a task names (its backticked identifiers and the exports of its files).
const docsFor = (
  docs: BriefingDocs,
  repo: RepoRef,
  tank: Pick<TankShape, "readFile">,
  ctx: TankContext,
  query: string,
  paths: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<DocHit>, unknown> =>
  Effect.gen(function* () {
    const files = ctx.worktree === undefined ? [] : yield* symbolFiles(tank, ctx, paths)
    const symbols = taskSymbols(query, files)
    return symbols.length === 0 ? [] : yield* docs(repo, symbols)
  })

// The code search of the repo a task names. The caller resolves the repo's index key from the RepoRef.
export type BriefingCode = (
  repo: RepoRef,
  query: string,
  k: number,
) => Effect.Effect<ReadonlyArray<CodeSearchHit>, unknown>

// The same search, ranked with the six signals (T-096): `activeFiles` are the files the task is about. It also reports
// the candidates it considered, which context.assembled records.
export type BriefingRankedCode = (
  repo: RepoRef,
  query: string,
  activeFiles: ReadonlyArray<string>,
  k: number,
) => Effect.Effect<RankedCode, unknown>

export interface BriefingDeps {
  readonly memory?: BriefingMemory | undefined
  readonly code?: BriefingCode | undefined
  // When present it serves the code block; the plain `code` search is the fallback if it fails.
  readonly rankedCode?: BriefingRankedCode | undefined
  // When present, serves the docs block (T-099) for the task's symbols; without it there is no docs block.
  readonly docs?: BriefingDocs | undefined
  readonly tank: Pick<TankShape, "readFile">
  // A source that fails is reported here and left out; the briefing is built with the others.
  readonly onSourceError: (source: BriefingSource, cause: Cause.Cause<unknown>) => Effect.Effect<void>
}

export interface BriefingInput {
  readonly spec: TaskSpec
  readonly bot: Bot
  readonly ctx: TankContext
  readonly plan: ContextPlan
  readonly config: ContextConfig
  // Recent events of the task, newest first (working memory); empty when the run is the first.
  readonly working?: ReadonlyArray<string> | undefined
  // Files the task is about besides the ones its prompt names (the files the previous attempt edited, on a retry).
  readonly activeFiles?: ReadonlyArray<string> | undefined
}

// The text handed to the executor (AGENTS.md body, system prompt or head of the prompt) and what it cost.
export interface Briefing {
  readonly text: string
  readonly level: ContextLevel
  readonly used: number
  readonly budget: number
  readonly dropped: ReadonlyArray<{ readonly block: string; readonly items: number }>
  // The code candidates the ranker considered, when the code was ranked.
  readonly ranked?: RankedCode["considered"] | undefined
}

// A source that fails is reported and replaced by `fallback`; an interruption is never swallowed.
const soft = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  fallback: A,
  source: BriefingSource,
  deps: BriefingDeps,
): Effect.Effect<A, never, R> =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : deps.onSourceError(source, cause).pipe(Effect.as(fallback)),
    ),
  )

// The briefing of one execution: the Bot's role, the repo rules that match the task, the memories and code most related
// to it (as many as the level asks for), the task and its acceptance criteria, assembled in the order the prompt cache
// likes and fitted to the tier's budget. Memory, code and rules are data (R14): redacted, and never obeyed.
export const buildBriefing = (deps: BriefingDeps, input: BriefingInput): Effect.Effect<Briefing> =>
  Effect.gen(function* () {
    const { spec, bot, ctx, plan, config } = input
    const query = `${spec.prompt}\n${spec.title}`
    const wantsContext = plan.level !== "none"
    const memoryHits: ReadonlyArray<Scored> =
      wantsContext && deps.memory !== undefined && plan.memoryK > 0
        ? yield* soft(
            deps.memory.search(query, {
              scopes: [
                { scope: "bot", ownerId: bot.id },
                { scope: "global", ownerId: "global" },
              ],
              k: plan.memoryK,
            }),
            [],
            "memory",
            deps,
          )
        : []
    const wantsCode = wantsContext && spec.repo !== undefined && plan.codeK > 0
    const activeFiles = [...new Set([...activeFilesFromText(query), ...(input.activeFiles ?? [])])]
    const ranked: RankedCode | undefined =
      wantsCode && deps.rankedCode !== undefined && spec.repo !== undefined
        ? yield* soft(deps.rankedCode(spec.repo, query, activeFiles, plan.codeK), undefined, "code", deps)
        : undefined
    const codeHits: ReadonlyArray<CodeSearchHit> =
      ranked !== undefined
        ? ranked.hits
        : wantsCode && deps.code !== undefined && spec.repo !== undefined
          ? yield* soft(deps.code(spec.repo, query, plan.codeK), [], "code", deps)
          : []
    const ruleItems =
      wantsContext && ctx.worktree !== undefined
        ? yield* soft(
            readRuleItems(deps.tank, ctx, { text: query, activeFiles, kind: spec.kind }),
            [],
            "rules",
            deps,
          )
        : []
    // The history of the files the task is about, read from its worktree (T-099): no worktree or no file, no history.
    const history: History =
      wantsContext && ctx.worktree !== undefined && activeFiles.length > 0
        ? yield* soft(historyOf(ctx.worktree.path, activeFiles), NO_HISTORY, "git", deps)
        : NO_HISTORY
    const docHits: ReadonlyArray<DocHit> =
      wantsCode && deps.docs !== undefined && spec.repo !== undefined
        ? yield* soft(docsFor(deps.docs, spec.repo, deps.tank, ctx, query, activeFiles), [], "docs", deps)
        : []
    const blocks: ReadonlyArray<Block> = [
      instructionsBlock(bot, config),
      rulesBlock(ruleItems, config),
      memoryBlock(memoryHits, config),
      codeBlock(codeHits, config),
      gitBlock(history.commits, history.diffs, config),
      docsBlock(docHits, config),
      workingBlock(input.working ?? [], config),
      acceptanceBlock(spec, config),
      ...(spec.origin === "bot" ? [handoffBlock(spec)] : []),
      taskBlock(spec, config),
    ]
    const assembled = assemble(blocks, plan.budgetTokens, config.reserve_for_answer)
    return {
      text: assembled.text,
      level: plan.level,
      used: assembled.used,
      budget: Math.max(0, plan.budgetTokens - config.reserve_for_answer),
      dropped: assembled.dropped,
      // A chunk is used only if the assembled text still carries it: the budget may have cut it after ranking.
      ...(ranked === undefined
        ? {}
        : {
            ranked: ranked.considered.map((entry) => ({
              ...entry,
              used: entry.used && assembled.kept.has(entry.id),
            })),
          }),
    }
  })
