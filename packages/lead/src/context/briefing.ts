import type { Bot, RepoRef, TaskSpec } from "@shoalwork/contracts"
import type { CodeSearchHit, ReefShape, Scored } from "@shoalwork/reef"
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

export interface BriefingDeps {
  readonly memory?: BriefingMemory | undefined
  readonly code?: BriefingCode | undefined
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
}

// The text handed to the executor (AGENTS.md body, system prompt or head of the prompt) and what it cost.
export interface Briefing {
  readonly text: string
  readonly level: ContextLevel
  readonly used: number
  readonly budget: number
  readonly dropped: ReadonlyArray<{ readonly block: string; readonly items: number }>
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
    const codeHits: ReadonlyArray<CodeSearchHit> =
      wantsContext && deps.code !== undefined && spec.repo !== undefined && plan.codeK > 0
        ? yield* soft(deps.code(spec.repo, query, plan.codeK), [], "code", deps)
        : []
    const ruleItems =
      wantsContext && ctx.worktree !== undefined
        ? yield* soft(readRuleItems(deps.tank, ctx, query), [], "rules", deps)
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
    }
  })
