import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { it } from "@effect/vitest"
import { ExecutorId } from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import { describe, expect } from "vitest"
import { makeTokenizer, Tokenizer, TokenizerTest } from "../../src/context/tokenizer.js"
import {
  approxCounter,
  type CalibrationEntry,
  observedFactor,
  recalibrate,
  scanLang,
} from "../../src/context/tokenizer-approx.js"
import {
  DEFAULT_TOKENIZER_CONFIG,
  decodeTokenizerConfigText,
  factorsFor,
  loadTokenizerConfig,
  type TokenizerConfig,
} from "../../src/context/tokenizer-config.js"

const CLAUDE = Schema.decodeUnknownSync(ExecutorId)("claude-code")
const CODEX = Schema.decodeUnknownSync(ExecutorId)("codex")
const HOUR_MS = 60 * 60 * 1000

const CODE = "function add(a, b) { return a + b; }\n".repeat(20)
const PT =
  "Esta é uma mensagem de teste para verificar que não há erro nas pessoas com a rotina de trabalho. ".repeat(
    10,
  )
const EN =
  "This is a plain English sentence used to check that the system counts the words of the test. ".repeat(10)

const tokenizerWith = (config: TokenizerConfig = DEFAULT_TOKENIZER_CONFIG, now?: () => number) =>
  makeTokenizer({ config, now })

describe("approximation by language", () => {
  it("counts code, Portuguese and English at their own factors", () => {
    const counter = approxCounter({ code: 3.2, prose_pt: 3.5, prose_en: 4 })
    expect(counter(CODE)).toBe(Math.ceil(CODE.length / 3.2))
    expect(counter(PT)).toBe(Math.ceil(PT.length / 3.5))
    expect(counter(EN)).toBe(Math.ceil(EN.length / 4))
  })

  it.effect("the Tokenizer counts each language with its default factor", () =>
    Effect.gen(function* () {
      const tokenizer = tokenizerWith()
      expect(yield* tokenizer.count(CODE, CLAUDE)).toBe(Math.ceil(CODE.length / 3.2))
      expect(yield* tokenizer.count(PT, CLAUDE)).toBe(Math.ceil(PT.length / 3.5))
      expect(yield* tokenizer.count(EN, CLAUDE)).toBe(Math.ceil(EN.length / 4))
    }),
  )

  it("the empty text has no tokens and a lone surrogate still counts", () => {
    const counter = approxCounter({ code: 3.2, prose_pt: 3.5, prose_en: 4 })
    expect(counter("")).toBe(0)
    expect(Number.isInteger(counter("\uD83D"))).toBe(true)
  })

  it("scans the hostile 200 KB inputs in one pass, reading every code point once", () => {
    const hostile = "{;()=".repeat(33_000) + "a ".repeat(34_000)
    const scan = scanLang(hostile)
    expect(scan.steps).toBe([...hostile].length)
    expect(scan.lang).toBe("code")
    const longWord = `${"a".repeat(200_000)}!`
    expect(scanLang(longWord)).toEqual({ lang: "prose_en", steps: longWord.length })
  })
})

describe("recalibration", () => {
  it("folds one observation in with alpha 0.1 and counts it", () => {
    const next = recalibrate({ executor: "claude-code", lang: "prose_en", factor: 4, n: 0 }, 2)
    expect(next.factor).toBeCloseTo(3.8, 10)
    expect(next.n).toBe(1)
  })

  it("leaves the entry alone when the report is unusable", () => {
    const entry = { executor: "claude-code", lang: "code" as const, factor: 3.2, n: 4 }
    expect(recalibrate(entry, undefined)).toBe(entry)
    expect(observedFactor(EN, 0)).toBeUndefined()
    expect(observedFactor("", 10)).toBeUndefined()
    expect(observedFactor(EN, Number.NaN)).toBeUndefined()
  })

  it.effect("moves the factor of the executor after three usage reports", () =>
    Effect.gen(function* () {
      const tokenizer = tokenizerWith()
      const before = yield* tokenizer.count(EN, CLAUDE)
      const tokensIn = Math.round(EN.length / 3)
      const entries: Array<CalibrationEntry | undefined> = []
      for (let i = 0; i < 3; i += 1) {
        const entry = yield* tokenizer.observe(CLAUDE, EN, tokensIn)
        entries.push(entry)
      }
      expect(entries.map((entry) => entry?.n)).toEqual([1, 2, 3])
      const last = entries[2]
      expect(last?.factor).toBeGreaterThan(3)
      expect(last?.factor).toBeLessThan(4)
      expect(yield* tokenizer.count(EN, CLAUDE)).toBeGreaterThan(before)
      // Calibration is per executor: the other executor keeps the default factor.
      expect(yield* tokenizer.count(EN, CODEX)).toBe(before)
    }),
  )
})

describe("cache", () => {
  it.effect("answers a repeated block from the cache, and drops it after a calibration", () =>
    Effect.gen(function* () {
      const tokenizer = tokenizerWith()
      const blocks = [
        { id: "instructions", text: EN },
        { id: "code", text: CODE },
      ]
      const first = yield* tokenizer.countBlocks(blocks, CLAUDE)
      expect(first.map((block) => block.source)).toEqual(["approx", "approx"])
      const second = yield* tokenizer.countBlocks(blocks, CLAUDE)
      expect(second.map((block) => block.source)).toEqual(["cache", "cache"])
      expect(second.map((block) => block.tokens)).toEqual(first.map((block) => block.tokens))
      yield* tokenizer.observe(CLAUDE, EN, Math.round(EN.length / 3))
      const afterCalibration = yield* tokenizer.countBlocks(blocks, CLAUDE)
      expect(afterCalibration.map((block) => block.source)).toEqual(["approx", "approx"])
    }),
  )

  it.effect("an empty block is exactly zero tokens and never a cache hit", () =>
    Effect.gen(function* () {
      const tokenizer = tokenizerWith()
      const blocks = [
        { id: "memory", text: "" },
        { id: "docs", text: "" },
      ]
      const counted = yield* tokenizer.countBlocks(blocks, CLAUDE)
      expect(counted).toEqual([
        { id: "memory", tokens: 0, source: "approx" },
        { id: "docs", tokens: 0, source: "approx" },
      ])
    }),
  )

  it.effect("forgets a count after the TTL (24 h)", () =>
    Effect.gen(function* () {
      let clock = 0
      const tokenizer = tokenizerWith(DEFAULT_TOKENIZER_CONFIG, () => clock)
      const blocks = [{ id: "rules", text: EN }]
      expect((yield* tokenizer.countBlocks(blocks, CLAUDE))[0]?.source).toBe("approx")
      clock = 24 * HOUR_MS - 1
      expect((yield* tokenizer.countBlocks(blocks, CLAUDE))[0]?.source).toBe("cache")
      clock = 24 * HOUR_MS + 1
      expect((yield* tokenizer.countBlocks(blocks, CLAUDE))[0]?.source).toBe("approx")
    }),
  )

  it.effect("keeps at most max_entries counts, evicting the least recently used", () =>
    Effect.gen(function* () {
      const config: TokenizerConfig = {
        ...DEFAULT_TOKENIZER_CONFIG,
        cache: { ttl_hours: 24, max_entries: 2 },
      }
      const tokenizer = tokenizerWith(config)
      const one = (text: string) => tokenizer.countBlocks([{ id: "b", text }], CLAUDE)
      yield* one(`${EN}a`)
      yield* one(`${EN}b`)
      yield* one(`${EN}c`)
      expect((yield* one(`${EN}a`))[0]?.source).toBe("approx")
      expect((yield* one(`${EN}c`))[0]?.source).toBe("cache")
    }),
  )
})

describe("TokenizerTest", () => {
  it.effect("counts chars / 4 in every language, without a cache", () =>
    Effect.gen(function* () {
      const tokenizer = yield* Tokenizer
      expect(yield* tokenizer.count("abcd", CLAUDE)).toBe(1)
      expect(yield* tokenizer.count("abcde", CLAUDE)).toBe(2)
    }).pipe(Effect.provide(TokenizerTest)),
  )
})

describe("config/tokenizer.yaml", () => {
  const shipped = join(
    fileURLToPath(new URL(".", import.meta.url)),
    "..",
    "..",
    "..",
    "..",
    "config",
    "tokenizer.yaml",
  )

  it.effect("decodes and matches the built-in defaults", () =>
    Effect.gen(function* () {
      expect(yield* loadTokenizerConfig(shipped)).toEqual(DEFAULT_TOKENIZER_CONFIG)
    }),
  )

  it.effect("rejects a config without a default executor and a factor out of range", () =>
    Effect.gen(function* () {
      const noDefault = yield* Effect.flip(
        decodeTokenizerConfigText("cache: {ttl_hours: 24, max_entries: 10}\nexecutors: {}\n", "t.yaml"),
      )
      expect(noDefault.message).toContain("default")
      const outOfRange = yield* Effect.flip(
        decodeTokenizerConfigText(
          "cache: {ttl_hours: 24, max_entries: 10}\nexecutors:\n  default: {code: 0.5, prose_pt: 3.5, prose_en: 4}\n",
          "t.yaml",
        ),
      )
      expect(outOfRange.key).toBe("t.yaml")
    }),
  )

  it("an executor without an entry takes the default factors", () => {
    expect(factorsFor(DEFAULT_TOKENIZER_CONFIG, "gemini")).toEqual({ code: 3.2, prose_pt: 3.5, prose_en: 4 })
  })
})
