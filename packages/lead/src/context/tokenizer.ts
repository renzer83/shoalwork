import { createHash } from "node:crypto"
import type { ExecutorId } from "@shoalwork/contracts"
import { Context, Effect, Layer } from "effect"
import { type Block, renderBlock } from "./assemble.js"
import {
  approxCounter,
  type CalibrationEntry,
  type Factors,
  type Lang,
  observedFactor,
  recalibrate,
  scanLang,
  type TokenCounter,
} from "./tokenizer-approx.js"
import { DEFAULT_TOKENIZER_CONFIG, factorsFor, type TokenizerConfig } from "./tokenizer-config.js"

// "cache" when the count was answered from the cache, "approx" when it was computed.
export type TokenSource = "approx" | "cache"

export interface BlockCount {
  readonly id: string
  readonly tokens: number
  readonly source: TokenSource
}

export interface TokenizerShape {
  // Never fails: the approximation has no network and no input it cannot count.
  readonly count: (text: string, executor: ExecutorId) => Effect.Effect<number>
  // One call per context assembly; the blocks are counted in order.
  readonly countBlocks: (
    blocks: ReadonlyArray<{ readonly id: string; readonly text: string }>,
    executor: ExecutorId,
  ) => Effect.Effect<ReadonlyArray<BlockCount>>
  // A sync counter with the executor's factors as they are now, for code that counts many times (assemble).
  readonly counter: (executor: ExecutorId) => Effect.Effect<TokenCounter>
  // Folds the usage an executor reported for `sentText` into its factor. Undefined when the report is unusable.
  readonly observe: (
    executor: ExecutorId,
    sentText: string,
    tokensIn: number,
  ) => Effect.Effect<CalibrationEntry | undefined>
}

export class Tokenizer extends Context.Service<Tokenizer, TokenizerShape>()("@shoalwork/Tokenizer") {}

// How the counts of a briefing were made (T-095): "mixed" when some block was answered from the cache.
export type ContextTokenSource = "approx" | "mixed"

// One countBlocks call per assembly, on the blocks as they were offered: "mixed" when some block's count came from the
// cache, "approx" when all were computed.
export const tokenSourceOf = (
  tokenizer: TokenizerShape,
  executor: ExecutorId,
  blocks: ReadonlyArray<Block>,
): Effect.Effect<ContextTokenSource> =>
  tokenizer
    .countBlocks(
      blocks.map((block) => ({ id: block.name, text: renderBlock(block) })),
      executor,
    )
    .pipe(
      Effect.map(
        (counts): ContextTokenSource =>
          counts.some((count) => count.source === "cache") ? "mixed" : "approx",
      ),
    )

export interface MakeTokenizerOptions {
  readonly config: TokenizerConfig
  // Calibration rows read back from tokenizer_calibration at boot.
  readonly persisted?: ReadonlyArray<CalibrationEntry> | undefined
  // Clock of the cache (epoch milliseconds); injected so the TTL is testable.
  readonly now?: (() => number) | undefined
}

const HOUR_MS = 60 * 60 * 1000
const keyOf = (executor: string, lang: Lang): string => `${executor}\u0000${lang}`

interface CacheEntry {
  readonly tokens: number
  readonly at: number
}

interface Counted {
  readonly tokens: number
  readonly source: TokenSource
}

// The in-memory Tokenizer: calibrated factors per executor and language, plus an LRU cache of counts keyed by the
// hash of the text. The cache is per factor generation: an observation changes the factors, so older counts are not reused.
export const makeTokenizer = (options: MakeTokenizerOptions): TokenizerShape => {
  const { config } = options
  const now = options.now ?? (() => Date.now())
  const ttlMs = config.cache.ttl_hours * HOUR_MS
  const factors = new Map<string, number>()
  const observations = new Map<string, number>()
  for (const entry of options.persisted ?? []) {
    factors.set(keyOf(entry.executor, entry.lang), entry.factor)
    observations.set(keyOf(entry.executor, entry.lang), entry.n)
  }
  const cache = new Map<string, CacheEntry>()
  let generation = 0

  const factorTable = (executor: string): Factors => {
    const base = factorsFor(config, executor)
    const pick = (lang: Lang): number => factors.get(keyOf(executor, lang)) ?? base[lang]
    return { code: pick("code"), prose_pt: pick("prose_pt"), prose_en: pick("prose_en") }
  }

  const lookup = (key: string, at: number): number | undefined => {
    const hit = cache.get(key)
    if (hit === undefined) return undefined
    // Re-inserted at the end: the Map keeps insertion order, so the first key is the least recently used.
    cache.delete(key)
    if (at - hit.at > ttlMs) return undefined
    cache.set(key, hit)
    return hit.tokens
  }

  const store = (key: string, tokens: number, at: number): void => {
    cache.delete(key)
    cache.set(key, { tokens, at })
    while (cache.size > config.cache.max_entries) {
      const oldest = cache.keys().next()
      if (oldest.done === true) break
      cache.delete(oldest.value)
    }
  }

  // The counter of one executor at one instant and factor generation. Counts go through the cache.
  const countWith = (executor: string, at: number): ((text: string) => Counted) => {
    const approx = approxCounter(factorTable(executor))
    const gen = generation
    return (text) => {
      // The empty text is exactly zero tokens: it is not an estimate, so it is neither looked up nor stored.
      if (text.length === 0) return { tokens: 0, source: "approx" }
      const key = `${executor}\u0000${gen}\u0000${createHash("sha256").update(text).digest("hex")}`
      const hit = lookup(key, at)
      if (hit !== undefined) return { tokens: hit, source: "cache" }
      const tokens = approx(text)
      store(key, tokens, at)
      return { tokens, source: "approx" }
    }
  }

  return {
    count: (text, executor) => Effect.sync(() => countWith(executor, now())(text).tokens),
    countBlocks: (blocks, executor) =>
      Effect.sync(() => {
        const counted = countWith(executor, now())
        return blocks.map((block) => {
          const { tokens, source } = counted(block.text)
          return { id: block.id, tokens, source }
        })
      }),
    counter: (executor) =>
      Effect.sync(() => {
        const counted = countWith(executor, now())
        return (text: string) => counted(text).tokens
      }),
    observe: (executor, sentText, tokensIn) =>
      Effect.sync(() => {
        const observed = observedFactor(sentText, tokensIn)
        if (observed === undefined) return undefined
        const lang = scanLang(sentText).lang
        const key = keyOf(executor, lang)
        const current: CalibrationEntry = {
          executor,
          lang,
          factor: factorTable(executor)[lang],
          n: observations.get(key) ?? 0,
        }
        const next = recalibrate(current, observed)
        factors.set(key, next.factor)
        observations.set(key, next.n)
        generation += 1
        return next
      }),
  }
}

// The Tokenizer of a Lead: calibrated factors, persisted rows restored at boot. The composition root passes both.
export const TokenizerLive = (
  config: TokenizerConfig = DEFAULT_TOKENIZER_CONFIG,
  persisted: ReadonlyArray<CalibrationEntry> = [],
): Layer.Layer<Tokenizer> =>
  Layer.effect(
    Tokenizer,
    Effect.sync(() => makeTokenizer({ config, persisted })),
  )

// Deterministic for tests: chars / 4 in every language, no cache, no calibration.
const FLAT: Factors = { code: 4, prose_pt: 4, prose_en: 4 }
const flatCounter = approxCounter(FLAT)
export const TokenizerTest: Layer.Layer<Tokenizer> = Layer.succeed(Tokenizer, {
  count: (text) => Effect.succeed(flatCounter(text)),
  countBlocks: (blocks) =>
    Effect.succeed(
      blocks.map(
        (block): BlockCount => ({ id: block.id, tokens: flatCounter(block.text), source: "approx" }),
      ),
    ),
  counter: () => Effect.succeed(flatCounter),
  observe: () => Effect.succeed(undefined),
})
