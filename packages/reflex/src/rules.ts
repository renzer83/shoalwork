import type { BotId, ExecutorId } from "@shoalwork/contracts"
import { limitsOf, type ReflexConfig } from "./config.js"
import type { Facts, Intent, Language, Scored } from "./contract.js"

// Confidence levels of the v0 rules (no model involved).
const STRONG = 0.9 // whole-word keyword, explicit mention or hint
const ROLE = 0.7 // Bot picked by its role
const WEAK = 0.6 // weak heuristic: repo presence, stopwords, sequence words
const DEFAULT = 0.5 // no rule matched
const UNKNOWN = 0.3 // no owner candidate at all
const NONE = 0

const WORD_START = "(?<![\\p{L}\\p{N}_])"
const WORD_END = "(?![\\p{L}\\p{N}_])"

// Structural patterns that are not keyword tables. Linear: no nested quantifiers over whitespace.
const ROUTINE_HOUR = /(?<![\p{L}\p{N}_])às\s+\d/iu
const LIST_LINE = /^[ \t]*(?:\d+\.|-)[ \t]/m

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// Whole words, case-insensitive, Unicode-aware (\b is ASCII-only in JS). Longest first, so phrases win.
const compileWords = (words: ReadonlyArray<string>): RegExp => {
  const alternatives = [...words]
    .map((word) => word.trim())
    .sort((a, b) => b.length - a.length)
    .map((word) => escapeRegex(word).replace(/\s+/g, "\\s+"))
  return new RegExp(`${WORD_START}(?:${alternatives.join("|")})${WORD_END}`, "giu")
}

const hasMatch = (pattern: RegExp, text: string): boolean => text.search(pattern) !== -1

const countMatches = (pattern: RegExp, text: string): number => [...text.matchAll(pattern)].length

const distinctMatches = (pattern: RegExp, text: string): number =>
  new Set([...text.matchAll(pattern)].map((match) => match[0].toLowerCase().replace(/\s+/g, " "))).size

export interface CompiledRules {
  readonly code: RegExp
  readonly research: RegExp
  readonly appOp: RegExp
  readonly routine: RegExp
  readonly verbs: RegExp
  readonly sequence: RegExp
  readonly high: RegExp
  readonly external: RegExp
  readonly local: RegExp
  readonly languages: ReadonlyArray<{ readonly lang: Exclude<Language, "other">; readonly words: RegExp }>
  readonly ownerRoles: ReadonlyArray<string>
  readonly leadName: string
  readonly ruleChars: number
  readonly payloadChars: number
  // Memo of the mention pattern per Bot name; compiled once per name, reused across asks.
  readonly mentions: Map<string, RegExp>
}

export const compileRules = (config: ReflexConfig): CompiledRules => ({
  code: compileWords(config.intent.code),
  research: compileWords(config.intent.research),
  appOp: compileWords(config.intent.app_op),
  routine: compileWords(config.intent.routine),
  verbs: compileWords(config.verbs),
  sequence: compileWords(config.sequence),
  high: compileWords(config.risk.high),
  external: compileWords(config.risk.external),
  local: compileWords(config.risk.local),
  languages: [
    { lang: "pt", words: compileWords(config.language.pt) },
    { lang: "en", words: compileWords(config.language.en) },
    { lang: "es", words: compileWords(config.language.es) },
  ],
  ownerRoles: config.owner.roles.map((role) => role.toLowerCase()),
  leadName: config.owner.leadName,
  ruleChars: limitsOf(config).ruleChars,
  payloadChars: limitsOf(config).payloadChars,
  mentions: new Map(),
})

// Every rule reads the same view of the text: NFC-normalized and cut to `ruleChars`.
const textOf = (facts: Facts, c: CompiledRules): string => facts.text.normalize("NFC").slice(0, c.ruleChars)

const mentionPattern = (name: string, c: CompiledRules): RegExp => {
  const cached = c.mentions.get(name)
  if (cached !== undefined) {
    return cached
  }
  const pattern = compileWords([name])
  c.mentions.set(name, pattern)
  return pattern
}

export const intentRule = (facts: Facts, c: CompiledRules): Scored<Intent> => {
  const text = textOf(facts, c).trim()
  if (text.startsWith("/")) {
    return { value: "system", confidence: STRONG }
  }
  if (hasMatch(c.code, text)) {
    return { value: "code", confidence: STRONG }
  }
  if (hasMatch(c.research, text)) {
    return { value: "research", confidence: STRONG }
  }
  if (hasMatch(c.appOp, text)) {
    return { value: "app_op", confidence: STRONG }
  }
  if (hasMatch(c.routine, text) || hasMatch(ROUTINE_HOUR, text)) {
    return { value: "routine", confidence: STRONG }
  }
  // Repo presence is weak evidence: explicit keywords above take precedence.
  if (facts.hasRepo) {
    return { value: "code", confidence: WEAK }
  }
  return { value: "chat", confidence: DEFAULT }
}

const lengthPoints = (length: number): number => {
  if (length < 80) {
    return 0
  }
  if (length < 200) {
    return 1
  }
  return length < 400 ? 2 : 3
}

export const complexityRule = (facts: Facts, c: CompiledRules): Scored<number> => {
  const text = textOf(facts, c).trim()
  const verbs = distinctMatches(c.verbs, text)
  const verbPoints = verbs >= 3 ? 2 : verbs === 2 ? 1 : 0
  const sequencePoints = hasMatch(c.sequence, text) ? 1 : 0
  return { value: Math.min(4, lengthPoints(text.length) + verbPoints + sequencePoints), confidence: WEAK }
}

// The Bot mentioned first in the text (@name or the bare name) wins.
const firstMentioned = (facts: Facts, text: string, c: CompiledRules): Facts["bots"][number] | undefined => {
  let best: { readonly bot: Facts["bots"][number]; readonly at: number } | undefined
  for (const bot of facts.bots) {
    const at = text.search(mentionPattern(bot.name, c))
    if (at !== -1 && (best === undefined || at < best.at)) {
      best = { bot, at }
    }
  }
  return best?.bot
}

// Order: explicit hint, mention of a Bot name, code intent to a dev/worker role, lead.
export const ownerRule = (facts: Facts, c: CompiledRules, intent: Intent): Scored<BotId | "new"> => {
  const hinted = facts.botHint === undefined ? undefined : facts.bots.find((bot) => bot.id === facts.botHint)
  if (hinted !== undefined) {
    return { value: hinted.id, confidence: STRONG }
  }
  const mentioned = firstMentioned(facts, textOf(facts, c), c)
  if (mentioned !== undefined) {
    return { value: mentioned.id, confidence: STRONG }
  }
  if (intent === "code") {
    const worker = facts.bots.find((bot) => {
      const role = bot.role.toLowerCase()
      return c.ownerRoles.some((ownerRole) => role.includes(ownerRole))
    })
    if (worker !== undefined) {
      return { value: worker.id, confidence: ROLE }
    }
  }
  const lead = facts.bots.find((bot) => bot.name === c.leadName)
  if (lead !== undefined) {
    return { value: lead.id, confidence: WEAK }
  }
  return { value: "new", confidence: UNKNOWN }
}

// Owner's preferred list first, then its allowed list; only executors reported available qualify.
// An owner without routing (or "new") has no executor: none, confidence 0.
export const executorRule = (facts: Facts, owner: BotId | "new"): Scored<ExecutorId | "none"> => {
  const available = new Set<ExecutorId>(facts.executors.filter((e) => e.available).map((e) => e.id))
  const routing = facts.bots.find((bot) => bot.id === owner)?.routing
  if (routing === undefined) {
    return { value: "none", confidence: NONE }
  }
  const preferred = routing.preferred.find((id) => available.has(id))
  if (preferred !== undefined) {
    return { value: preferred, confidence: STRONG }
  }
  const allowed = routing.allowed.find((id) => available.has(id))
  if (allowed !== undefined) {
    return { value: allowed, confidence: WEAK }
  }
  return { value: "none", confidence: NONE }
}

export const parallelizableRule = (facts: Facts, c: CompiledRules, complexity: number): Scored<boolean> => ({
  value: complexity >= 3 && LIST_LINE.test(textOf(facts, c)),
  confidence: WEAK,
})

export const riskRule = (facts: Facts, c: CompiledRules): Scored<number> => {
  const text = textOf(facts, c)
  if (hasMatch(c.high, text)) {
    return { value: 3, confidence: STRONG }
  }
  if (hasMatch(c.external, text)) {
    return { value: 2, confidence: STRONG }
  }
  if (hasMatch(c.local, text)) {
    return { value: 1, confidence: STRONG }
  }
  return { value: 0, confidence: DEFAULT }
}

export const needsApprovalRule = (risk: Scored<number>): Scored<boolean> => ({
  value: risk.value >= 2,
  confidence: risk.confidence,
})

// Stopword counts per language; the highest count wins, ties go to the order pt, en, es.
export const languageRule = (facts: Facts, c: CompiledRules): Scored<Language> => {
  const text = textOf(facts, c)
  let best: { readonly lang: Language; readonly hits: number } = { lang: "other", hits: 0 }
  for (const { lang, words } of c.languages) {
    const hits = countMatches(words, text)
    if (hits > best.hits) {
      best = { lang, hits }
    }
  }
  if (best.hits === 0) {
    return { value: "other", confidence: DEFAULT }
  }
  return { value: best.lang, confidence: best.hits >= 2 ? STRONG : WEAK }
}

export interface StandardScores {
  readonly intent: Scored<Intent>
  readonly complexity: Scored<number>
  readonly owner: Scored<BotId | "new">
  readonly executor: Scored<ExecutorId | "none">
  readonly parallelizable: Scored<boolean>
  readonly risk: Scored<number>
  readonly needs_approval: Scored<boolean>
  readonly language: Scored<Language>
}

// Pure: every standard question, with its dependencies computed once.
export const scoreAll = (facts: Facts, c: CompiledRules): StandardScores => {
  const intent = intentRule(facts, c)
  const complexity = complexityRule(facts, c)
  const owner = ownerRule(facts, c, intent.value)
  const executor = executorRule(facts, owner.value)
  const parallelizable = parallelizableRule(facts, c, complexity.value)
  const risk = riskRule(facts, c)
  const needsApproval = needsApprovalRule(risk)
  const language = languageRule(facts, c)
  return {
    intent,
    complexity,
    owner,
    executor,
    parallelizable,
    risk,
    needs_approval: needsApproval,
    language,
  }
}
