// Pure part of the Tokenizer (T-095): language detection, the chars-per-token approximation and the recalibration of a
// factor from the usage an executor reports. No I/O here; the service and its tables live in tokenizer.ts.

export type Lang = "code" | "prose_pt" | "prose_en"

// Chars per token for each language: tokens = ceil(chars / factor). A smaller factor means more tokens.
export type Factors = Readonly<Record<Lang, number>>

// Counts the tokens of a text. Sync and pure for a fixed factor table.
export type TokenCounter = (text: string) => number

export interface CalibrationEntry {
  readonly executor: string
  readonly lang: Lang
  readonly factor: number
  // Observations folded into the factor so far.
  readonly n: number
}

// A factor stays in this range whatever the observations say: a degenerate usage report cannot zero the budget.
export const FACTOR_MIN = 1
export const FACTOR_MAX = 10
// Weight of each new observation in the moving average (T-095: alpha 0.1).
export const RECALIBRATION_ALPHA = 0.1

const CODE_CHARS: ReadonlySet<string> = new Set(["{", "}", ";", "=", "(", ")"])
// At least this share of the characters is code punctuation: the text is code.
const CODE_RATIO = 0.02
// Disjoint sets: a word counts for one language only.
const PT_WORDS: ReadonlySet<string> = new Set([
  "de",
  "da",
  "do",
  "que",
  "não",
  "para",
  "com",
  "uma",
  "um",
  "os",
  "em",
  "é",
  "por",
  "mais",
  "como",
  "na",
  "no",
  "dos",
  "das",
  "se",
])
const EN_WORDS: ReadonlySet<string> = new Set([
  "the",
  "and",
  "of",
  "to",
  "is",
  "that",
  "for",
  "with",
  "it",
  "on",
  "are",
  "this",
  "be",
  "by",
  "or",
])
const LETTER = /\p{L}/u

export interface LangScan {
  readonly lang: Lang
  // Characters read. A single pass reads each code point once, so steps equals the code point count.
  readonly steps: number
}

// One pass over the text, no backtracking: the work grows with the length, whatever the input.
export const scanLang = (text: string): LangScan => {
  let code = 0
  let pt = 0
  let en = 0
  let word = ""
  let steps = 0
  const close = (): void => {
    if (PT_WORDS.has(word)) pt += 1
    else if (EN_WORDS.has(word)) en += 1
    word = ""
  }
  for (const ch of text) {
    steps += 1
    if (CODE_CHARS.has(ch)) code += 1
    if (LETTER.test(ch)) {
      word += ch.toLowerCase()
    } else if (word !== "") {
      close()
    }
  }
  if (word !== "") close()
  const lang: Lang =
    text.length === 0 || code / text.length < CODE_RATIO ? (pt > en ? "prose_pt" : "prose_en") : "code"
  return { lang, steps }
}

export const detectLang = (text: string): Lang => scanLang(text).lang

// The approximate count of a text at one factor. The empty text has no tokens.
export const approxTokens = (text: string, factor: number): number =>
  text.length === 0 ? 0 : Math.ceil(text.length / factor)

// A counter with one factor table: each text is counted at the factor of its language.
export const approxCounter =
  (factors: Factors): TokenCounter =>
  (text) =>
    approxTokens(text, factors[detectLang(text)])

const clamp = (value: number): number => Math.min(FACTOR_MAX, Math.max(FACTOR_MIN, value))

// The chars-per-token an executor's usage implies for the text it was sent: chars / tokens. Undefined when the
// report carries nothing usable (no text, no tokens, not a finite number).
export const observedFactor = (sentText: string, tokensIn: number): number | undefined =>
  sentText.length === 0 || !Number.isFinite(tokensIn) || tokensIn <= 0
    ? undefined
    : sentText.length / tokensIn

// Pure: folds one observed factor into the entry with the moving average. An unusable observation leaves it as it is.
export const recalibrate = (entry: CalibrationEntry, observed: number | undefined): CalibrationEntry => {
  if (observed === undefined || !Number.isFinite(observed)) return entry
  const factor = clamp((1 - RECALIBRATION_ALPHA) * entry.factor + RECALIBRATION_ALPHA * clamp(observed))
  return { ...entry, factor, n: entry.n + 1 }
}
