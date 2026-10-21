import type { Bot, RepoRef, TaskSpec } from "@shoalwork/contracts"
import {
  activeFilesFromText,
  type CodeSearchHit,
  type RankedCode,
  type ReefShape,
  type Scored,
} from "@shoalwork/reef"
import type { TankContext, TankShape } from "@shoalwork/tank"
import { Cause, Effect } from "effect"
import { assemble, type Block } from "./assemble.js"
import {
  acceptanceBlock,
  codeBlock,
  handoffBlock,
  instructionsBlock,
  memoryBlock,
  rulesBlock,
  taskBlock,
  workingBlock,
} from "./blocks.js"
import type { ContextConfig } from "./config.js"
import type { ContextLevel, ContextPlan } from "./planner.js"
import { readRuleItems } from "./rules.js"

// Only what the memory search needs: the Reef's search, so tests can answer with a fixture.
export type BriefingMemory = Pick<ReefShape, "search">

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
  readonly tank: Pick<TankShape, "readFile">
  // A source that fails is reported here and left out; the briefing is built with the others.
  readonly onSourceError: (
    source: "memory" | "code" | "rules",
    cause: Cause.Cause<unknown>,
  ) => Effect.Effect<void>
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
  source: "memory" | "code" | "rules",
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
    const blocks: ReadonlyArray<Block> = [
      instructionsBlock(bot, config),
      rulesBlock(ruleItems, config),
      memoryBlock(memoryHits, config),
      codeBlock(codeHits, config),
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
