import { Data, Effect } from "effect"
import { redactSecrets } from "../narrator.js"
import { BLOCK_ORDER, type Block, type BlockItem, type BlockName, renderBlock } from "./assemble.js"
import { type SummaryCache, type SummaryEntry, summaryKey } from "./compact-cache.js"
import { type FencedItem, fitTokens, splitFenced, stripCode, summarizeText } from "./compact-text.js"
import type { CompactionConfig } from "./config.js"
import { fenced } from "./fence.js"
import type { TokenCounter } from "./tokenizer-approx.js"

// 0 = intact; 1 = code without comments, blank lines and imports; 2 = summary of at most 40% (tier light); 3 = at most 15%.
export type CompactionLevel = 0 | 1 | 2 | 3
export type ActiveLevel = Exclude<CompactionLevel, 0>

export const SUMMARY_RATIO: Readonly<Record<2 | 3, number>> = { 2: 0.4, 3: 0.15 }

// The summarizer is a port: a model tier "light" run (one turn, fixed prompt) or the deterministic one below. It fails
// when it is not available; the item then keeps what the previous level gave it, and the cut takes over (T-041).
export class SummarizerError extends Data.TaggedError("SummarizerError")<{ readonly reason: string }> {}

export interface Summarizer {
  // Names the summarizer in the cache key: one summarizer never reads the summaries of another.
  readonly id: string
  readonly summarize: (text: string, maxTokens: number) => Effect.Effect<string, SummarizerError>
}

// The default summarizer: no model and no network, so it is always available. Its output is data, as its input was.
export const extractiveSummarizer: Summarizer = {
  id: "extractive-1",
  summarize: (text, maxTokens) => Effect.succeed(summarizeText(text, maxTokens)),
}

export interface CompactDeps {
  // The Tokenizer's counter of the executor (the same one assemble counts with).
  readonly count: TokenCounter
  readonly summarizer: Summarizer
  // Names the summarizer and the counter in the cache key: a summary depends on both.
  readonly scope: string
  // Summaries reused between briefings; without it every summary is made again.
  readonly cache?: SummaryCache | undefined
  // Items smaller than this (tokens) are not summarized: a summary would not save what it costs.
  readonly minItemTokens: number
}

// The arguments of a briefing's compaction. `counterId` names the executor whose counter this is ("approx" when none).
export interface BriefingCompaction {
  readonly count: TokenCounter
  readonly counterId?: string | undefined
  readonly summarizer?: Summarizer | undefined
  readonly cache?: SummaryCache | undefined
  readonly config: CompactionConfig
}

// What compaction did to one block: the deepest level it reached and its tokens before and after.
export interface CompactionEntry {
  readonly block: BlockName
  readonly level: ActiveLevel
  readonly before: number
  readonly after: number
}

// The order of attack when the blocks are over the budget (T-097). docs and git are not compacted: they are cut.
const ATTACK: ReadonlyArray<{ readonly block: BlockName; readonly level: ActiveLevel }> = [
  { block: "code", level: 1 },
  { block: "code", level: 2 },
  { block: "code", level: 3 },
  { block: "memory", level: 2 },
  { block: "memory", level: 3 },
  { block: "working", level: 2 },
  { block: "working", level: 3 },
  { block: "rules", level: 2 },
]

// The blocks as assemble joins them, for one count.
const textOf = (blocks: ReadonlyMap<BlockName, Block>): string =>
  BLOCK_ORDER.flatMap((name) => {
    const block = blocks.get(name)
    return block === undefined ? [] : [renderBlock(block)]
  })
    .filter((part) => part !== "")
    .join("\n\n")

// A head line (the path or the title of an excerpt) above its body; no head, no line.
const withHead = (head: string, body: string): string => (head === "" ? body : `${head}\n${body}`)

// The text of an item after level 1: a fenced excerpt with its code stripped, fenced again. Any other item has no code.
const strippedText = (text: string, parts: FencedItem | undefined): string =>
  parts === undefined ? text : withHead(parts.head, fenced(stripCode(parts.body)))

// A summary of `text` at `level` within its share of the tokens, redacted. Undefined when the summarizer is not available
// or the summary comes out empty: an empty summary is nothing to keep, so nothing is cached either.
const summarizeOne = (text: string, level: 2 | 3, deps: CompactDeps): Effect.Effect<string | undefined> => {
  const target = Math.floor(deps.count(text) * SUMMARY_RATIO[level])
  return deps.summarizer.summarize(text, target).pipe(
    Effect.map((summary) => fitTokens(redactSecrets(summary), target, deps.count)),
    Effect.map((summary): string | undefined => (summary.trim() === "" ? undefined : summary)),
    Effect.catch((error) =>
      Effect.logWarning("context summarizer unavailable", error.reason).pipe(Effect.as(undefined)),
    ),
  )
}

// The summaries of the sources at `level`, aligned with them: one read of the cache for the eligible ones, the misses
// made one by one, and the new summaries written back in one write. Undefined where a source is too small or no summary
// is made.
const summariesOf = (
  sources: ReadonlyArray<string>,
  level: 2 | 3,
  deps: CompactDeps,
): Effect.Effect<ReadonlyArray<string | undefined>> =>
  Effect.gen(function* () {
    const rows = sources.map((text) => ({
      text,
      key: summaryKey(deps.scope, level, text),
      eligible: deps.count(text) >= deps.minItemTokens,
    }))
    const wanted = rows.filter((row) => row.eligible).map((row) => row.key)
    const cached: ReadonlyMap<string, string> =
      deps.cache === undefined || wanted.length === 0 ? new Map() : yield* deps.cache.getMany(wanted)
    const fresh: Array<SummaryEntry> = []
    const out: Array<string | undefined> = []
    for (const row of rows) {
      if (!row.eligible) {
        out.push(undefined)
        continue
      }
      const hit = cached.get(row.key)
      if (hit !== undefined) {
        out.push(hit)
        continue
      }
      const made = yield* summarizeOne(row.text, level, deps)
      out.push(made)
      if (made !== undefined) fresh.push({ key: row.key, level, summary: made, tokens: deps.count(made) })
    }
    if (deps.cache !== undefined && fresh.length > 0) yield* deps.cache.putMany(fresh)
    return out
  })

// The item with `text` in its place, when that is shorter. Level 1 keeps the id: the chunk is still the chunk, minus its
// comments, and the ranker counts it as used. A summary is no longer the chunk, so it carries no id.
const replaced = (item: BlockItem, text: string, keepId: boolean, deps: CompactDeps): BlockItem => {
  if (deps.count(text) >= deps.count(item.text)) return item
  return keepId ? { ...item, text } : { score: item.score, text }
}

// The block at `level` (1 to 3), computed from its intact self. Level 0 is the block as it is.
export const compactBlock = (block: Block, level: CompactionLevel, deps: CompactDeps): Effect.Effect<Block> =>
  Effect.gen(function* () {
    if (level === 0) return block
    const rows = block.items.map((item) => ({ item, parts: splitFenced(item.text) }))
    if (level === 1) {
      return {
        ...block,
        items: rows.map(({ item, parts }) => replaced(item, strippedText(item.text, parts), true, deps)),
      }
    }
    const sources = rows.map(({ item, parts }) => (parts === undefined ? item.text : stripCode(parts.body)))
    const summaries = yield* summariesOf(sources, level, deps)
    return {
      ...block,
      items: rows.map(({ item, parts }, index) => {
        const summary = summaries[index]
        const text =
          summary === undefined
            ? strippedText(item.text, parts)
            : withHead(parts?.head ?? "", fenced(summary))
        return replaced(item, text, false, deps)
      }),
    }
  })

export interface Compacted {
  readonly blocks: ReadonlyArray<Block>
  readonly compaction: ReadonlyArray<CompactionEntry>
}

// Compacts the blocks in the order of attack, one step at a time, until the whole is within `available` (the budget less
// the answer reserve). Each step is counted. Nothing is dropped here: what is still over the budget is cut by assemble.
// When the blocks assemble never cuts first (the fixed ones) are over the budget by themselves, that is logged and the
// compaction goes on: assemble cuts them, and the task block stays.
export const compactToBudget = (
  blocks: ReadonlyArray<Block>,
  available: number,
  briefing: BriefingCompaction,
): Effect.Effect<Compacted> =>
  Effect.gen(function* () {
    const summarizer = briefing.summarizer ?? extractiveSummarizer
    const deps: CompactDeps = {
      count: briefing.count,
      summarizer,
      scope: `${summarizer.id}|${briefing.counterId ?? "approx"}`,
      cache: briefing.cache,
      minItemTokens: briefing.config.minItemTokens,
    }
    const maxLevel = briefing.config.levels
    const byName = new Map(blocks.map((block) => [block.name, block] as const))
    // The blocks assemble treats as fixed (instructions, rules, acceptance, handoff, task): cut last, never the task.
    const fixed = new Map(blocks.filter((block) => block.fixed).map((block) => [block.name, block] as const))
    const fixedTokens = deps.count(textOf(fixed))
    if (fixedTokens > available) {
      yield* Effect.logWarning(
        `fixed blocks need ${fixedTokens} tokens, more than the ${available} left: assemble will cut them`,
      )
    }
    if (deps.count(textOf(byName)) <= available) return { blocks, compaction: [] }

    const originals = new Map(byName)
    const current = new Map(byName)
    const applied = new Map<BlockName, ActiveLevel>()
    for (const step of ATTACK) {
      if (step.level > maxLevel) continue
      const original = originals.get(step.block)
      if (original === undefined || original.items.length === 0) continue
      current.set(step.block, yield* compactBlock(original, step.level, deps))
      applied.set(step.block, step.level)
      if (deps.count(textOf(current)) <= available) break
    }

    const compaction: Array<CompactionEntry> = []
    for (const [block, level] of applied) {
      const original = originals.get(block)
      const after = current.get(block)
      if (original === undefined || after === undefined) continue
      const before = deps.count(renderBlock(original))
      const tokens = deps.count(renderBlock(after))
      if (tokens < before) compaction.push({ block, level, before, after: tokens })
    }
    return {
      blocks: BLOCK_ORDER.flatMap((name) => {
        const block = current.get(name)
        return block === undefined ? [] : [block]
      }),
      compaction,
    }
  })
