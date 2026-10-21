import { createHash } from "node:crypto"
import { lstat, readdir } from "node:fs/promises"
import { join } from "node:path"
import { TankError } from "@shoalwork/contracts"
import { DEFAULT_MAX_FILE_BYTES, isIgnoredPath, looksLikeSecret } from "@shoalwork/reef"
import type { TankContext, TankShape } from "@shoalwork/tank"
import { Effect, Option } from "effect"
import { oneLine, redactSecrets } from "../narrator.js"
import type { BlockItem } from "./assemble.js"
import { clipLines, fenced } from "./fence.js"
import { CLAUDE_STUB, MARKER } from "./instructions-file.js"
import {
  frontmatterGlobs,
  globMatch,
  PATH_MAX,
  splitFrontmatter,
  splitSections,
  terms,
} from "./rules-markdown.js"
import { estimateTokens } from "./tokens.js"

// Precedence order. A directory is listed (git, through the Tank) and its direct children with the suffix are read.
export type RuleSource =
  | { readonly path: string; readonly keep?: RegExp | undefined }
  | { readonly dir: string; readonly suffix: string }
export const RULE_SOURCES: ReadonlyArray<RuleSource> = [
  { dir: ".agent/rules", suffix: ".md" },
  { dir: ".claude/rules", suffix: ".md" },
  { path: "CLAUDE.md" },
  { path: "AGENTS.md" },
  { path: ".cursorrules" },
  { dir: ".cursor/rules", suffix: ".mdc" },
  { path: "CONTRIBUTING.md", keep: /conventions|style|testing|commit/i },
]
const SECTION_MAX_CHARS = 1500
const HEADING_MAX = 80
const RULE_FILES_MAX = 20
const ACTIVE_FILES_MAX = 20
const TASK_TEXT_MAX = 4000
const BINARY_SNIFF = 8 * 1024
const CACHE_MAX = 32
const BM25_K1 = 1.2
const BM25_B = 0.75
const LEXICAL_MIN = 0.2
const UNIVERSAL = /always|sempre|never|nunca|must|obrigat/i

export interface RuleSection {
  readonly source: string
  readonly heading: string
  readonly text: string
  // Frontmatter globs (`paths:` or `globs:`): the section applies when an active file matches one of them.
  readonly paths?: ReadonlyArray<string> | undefined
  readonly tokens: number
}

// The task a rule is selected for: its text, the files it is about, and its kind.
export interface RuleTask {
  readonly text: string
  readonly activeFiles: ReadonlyArray<string>
  readonly kind: string
}

export interface SelectedRule extends RuleSection {
  readonly score: number
}

// Only a file that is not there is "no rules"; any other failure to read is the caller's to report.
export const isAbsent = (error: TankError): boolean => {
  const cause: unknown = error.cause
  if (cause instanceof Error) return "code" in cause && cause.code === "ENOENT"
  return typeof cause === "string" && /no such file or directory/i.test(cause)
}

// The same skips as the indexer's walker: too big, binary, secret-looking, or one of ours (the generated briefing or
// the CLAUDE.md stub that imports it).
const skippable = (text: string): boolean =>
  text.length > DEFAULT_MAX_FILE_BYTES ||
  text.slice(0, BINARY_SNIFF).includes("\0") ||
  text.startsWith(MARKER) ||
  text === CLAUDE_STUB ||
  looksLikeSecret(text)

// Parsed files, keyed by path and sha256 of the content: a file is parsed again only when it changed.
const parsedFiles = new Map<string, ReadonlyArray<RuleSection>>()
const remember = (key: string, value: ReadonlyArray<RuleSection>): void => {
  parsedFiles.set(key, value)
  const oldest = parsedFiles.keys().next()
  if (parsedFiles.size > CACHE_MAX && !oldest.done) parsedFiles.delete(oldest.value)
}

const parseRuleFile = (
  rel: string,
  text: string,
  keep: RegExp | undefined,
): Effect.Effect<ReadonlyArray<RuleSection>> =>
  Effect.gen(function* () {
    const key = `${rel}\0${createHash("sha256").update(text).digest("hex")}`
    const hit = parsedFiles.get(key)
    if (hit !== undefined) return hit
    const front = splitFrontmatter(text)
    const globs = front === undefined ? [] : yield* frontmatterGlobs(rel, front.front)
    const body = front === undefined ? text : front.body
    const sections = splitSections(body)
      .filter((piece) => keep === undefined || keep.test(piece.heading))
      .map(
        (piece): RuleSection => ({
          source: rel,
          heading: piece.heading,
          text: piece.body,
          ...(globs.length === 0 ? {} : { paths: globs }),
          tokens: estimateTokens(piece.body),
        }),
      )
    remember(key, sections)
    return sections
  })

const readRuleFile = (
  tank: Pick<TankShape, "readFile">,
  ctx: TankContext,
  rel: string,
  keep: RegExp | undefined,
): Effect.Effect<ReadonlyArray<RuleSection>, TankError> =>
  tank.readFile(ctx, rel).pipe(
    Effect.map(Option.some),
    Effect.catch((error: TankError) =>
      isAbsent(error) ? Effect.succeed(Option.none<string>()) : Effect.fail(error),
    ),
    Effect.flatMap((text) =>
      Option.isNone(text) || skippable(text.value)
        ? Effect.succeed([])
        : parseRuleFile(rel, text.value, keep),
    ),
  )

const isMissing = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT"

// The direct children of one rules directory of the worktree that are regular files with the suffix, and that the
// indexer would not skip. A symlink (to a file or to a directory) is not a rules directory and not a rules file.
const listRuleDir = async (root: string, dir: string, suffix: string): Promise<ReadonlyArray<string>> => {
  const absolute = join(root, dir)
  try {
    if (!(await lstat(absolute)).isDirectory()) return []
    const entries = await readdir(absolute, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
      .map((entry) => `${dir}/${entry.name}`)
      .filter((path) => !isIgnoredPath(path))
      .sort()
      .slice(0, RULE_FILES_MAX)
  } catch (cause) {
    if (isMissing(cause)) return []
    throw cause
  }
}

// Every section of the repo's rules files, in precedence order. A missing file or directory counts as no rules; any
// other failure to read is reported by the caller.
export const collectRules = (
  tank: Pick<TankShape, "readFile">,
  ctx: TankContext,
): Effect.Effect<ReadonlyArray<RuleSection>, TankError> =>
  Effect.gen(function* () {
    const root = ctx.cwd
    const files: Array<{ readonly rel: string; readonly keep?: RegExp | undefined }> = []
    for (const source of RULE_SOURCES) {
      if ("dir" in source) {
        const listed = yield* Effect.tryPromise({
          try: () => listRuleDir(root, source.dir, source.suffix),
          catch: (cause) => new TankError({ op: "listRules", cause }),
        })
        files.push(...listed.map((rel) => ({ rel })))
      } else {
        files.push({ rel: source.path, keep: source.keep })
      }
    }
    const perFile = yield* Effect.forEach(files, (file) => readRuleFile(tank, ctx, file.rel, file.keep))
    return perFile.flat()
  })

// BM25 over heading and text of each rule, scaled so that the best match scores 1. The idf is the Lucene form, which
// stays positive when a term is in every rule.
const lexicalScores = (
  rules: ReadonlyArray<RuleSection>,
  query: ReadonlyArray<string>,
): ReadonlyArray<number> => {
  const docs = rules.map((rule) => {
    const all = terms(`${rule.heading} ${rule.text}`)
    const counts = new Map<string, number>()
    for (const term of all) counts.set(term, (counts.get(term) ?? 0) + 1)
    return { counts, length: all.length }
  })
  const df = new Map<string, number>()
  for (const doc of docs) for (const term of doc.counts.keys()) df.set(term, (df.get(term) ?? 0) + 1)
  const average = Math.max(1, docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, docs.length))
  const unique = [...new Set(query)]
  const scores = docs.map((doc) =>
    unique.reduce((sum, term) => {
      const tf = doc.counts.get(term) ?? 0
      if (tf === 0) return sum
      const n = df.get(term) ?? 0
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5))
      return (
        sum + (idf * tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + (BM25_B * doc.length) / average))
      )
    }, 0),
  )
  const best = Math.max(0, ...scores)
  return best === 0 ? scores : scores.map((score) => score / best)
}

// The rules that apply to the task. A heading that states a standing rule (always, never, must) always applies (3).
// A section with globs applies when an active file matches one (2). A section without globs applies when its lexical
// score reaches the minimum (its score, between LEXICAL_MIN and 1).
export const selectRules = (
  rules: ReadonlyArray<RuleSection>,
  task: RuleTask,
): ReadonlyArray<SelectedRule> => {
  const active = task.activeFiles.slice(0, ACTIVE_FILES_MAX)
  const matched = new Map<string, boolean>()
  const globMatchesActive = (glob: string): boolean => {
    const known = matched.get(glob)
    if (known !== undefined) return known
    const hit = active.some((file) => file.length <= PATH_MAX && globMatch(glob, file))
    matched.set(glob, hit)
    return hit
  }
  const selected: Array<SelectedRule> = []
  const lexical: Array<RuleSection> = []
  for (const rule of rules) {
    if (UNIVERSAL.test(rule.heading.slice(0, HEADING_MAX))) {
      selected.push({ ...rule, score: 3 })
    } else if (rule.paths !== undefined) {
      if (rule.paths.some(globMatchesActive)) selected.push({ ...rule, score: 2 })
    } else {
      lexical.push(rule)
    }
  }
  const query = terms(`${task.text.slice(0, TASK_TEXT_MAX)} ${active.join(" ")} ${task.kind}`)
  const scores = lexicalScores(lexical, query)
  lexical.forEach((rule, index) => {
    const score = scores[index] ?? 0
    if (score >= LEXICAL_MIN) selected.push({ ...rule, score })
  })
  return selected.sort((a, b) => b.score - a.score)
}

// The section as the executor sees it: its heading flattened, redacted and capped, and its body (redacted, capped at a
// line) inside a fence that the text cannot close, so that nothing in it can read as a heading or an instruction.
const ruleText = (rule: RuleSection): string => {
  const heading = oneLine(redactSecrets(oneLine(rule.heading, 1000)), HEADING_MAX)
  return `## ${rule.source}: ${heading}\n${fenced(redactSecrets(clipLines(rule.text, SECTION_MAX_CHARS)))}`
}

// Items of the `rules` block: the sections selected for the task, best first. The caller trims them to the block's cap.
export const readRuleItems = (
  tank: Pick<TankShape, "readFile">,
  ctx: TankContext,
  task: RuleTask,
): Effect.Effect<ReadonlyArray<BlockItem>, TankError> =>
  collectRules(tank, ctx).pipe(
    Effect.map((rules) =>
      selectRules(rules, task).map((rule): BlockItem => ({ text: ruleText(rule), score: rule.score })),
    ),
  )
