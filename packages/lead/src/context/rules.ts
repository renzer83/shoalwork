import type { TankError } from "@shoalwork/contracts"
import type { TankContext, TankShape } from "@shoalwork/tank"
import { Effect, Option } from "effect"
import { oneLine, redactSecrets } from "../narrator.js"
import type { BlockItem } from "./assemble.js"
import { clipLines, fenced } from "./fence.js"
import { CLAUDE_STUB, MARKER } from "./instructions-file.js"

// The rules files a repo may carry, in the order they are read.
export const RULES_FILES: ReadonlyArray<string> = [".cursorrules", "AGENTS.md", "CLAUDE.md"]
const SECTION_MAX_CHARS = 1500
const HEADING_MAX = 80
const MIN_WORD = 3
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
const OPEN_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const CLOSE_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/
// A line that cannot be the text of a setext heading: blank, indented code, quote or list item.
const NOT_PARAGRAPH = /^(?:\s*$| {4}|\t|\s*>|\s*[-*+][ \t]|\s*\d+[.)][ \t])/

const words = (text: string): ReadonlyArray<string> =>
  (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => word.length >= MIN_WORD)

// "test" matches "tests" and "testing": a shared prefix of at least 4 letters that covers all but one letter of the
// shorter word.
const sameWord = (a: string, b: string): boolean => {
  if (a === b) return true
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1
  return prefix >= Math.max(4, Math.min(a.length, b.length) - 1)
}

export interface RuleSection {
  readonly heading: string
  readonly body: string
}

// Markdown split at its headings, the way CommonMark reads them: ATX (`# Title`) and setext (`Title` over `====`).
// A line inside a fenced code block never starts a section, and a fence opens only where CommonMark opens one (a
// backtick fence whose info string holds a backtick is plain text) and closes only with a fence of the same character
// and at least the same length. Text before the first heading belongs to no section.
export const splitSections = (markdown: string): ReadonlyArray<RuleSection> => {
  const sections: Array<{ heading: string; lines: Array<string> }> = []
  let fence: { readonly char: string; readonly length: number } | undefined
  let previous: string | undefined
  for (const line of markdown.split(/\r?\n/)) {
    const current = sections.at(-1)
    if (fence !== undefined) {
      const close = CLOSE_FENCE.exec(line)?.[1]
      if (close !== undefined && close[0] === fence.char && close.length >= fence.length) fence = undefined
      current?.lines.push(line)
      continue
    }
    const open = OPEN_FENCE.exec(line)
    if (open !== null && !((open[1] ?? "").startsWith("`") && (open[2] ?? "").includes("`"))) {
      fence = { char: (open[1] ?? "`")[0] ?? "`", length: (open[1] ?? "").length }
      current?.lines.push(line)
      previous = undefined
      continue
    }
    const atx = ATX.exec(line)
    if (atx !== null) {
      sections.push({ heading: (atx[2] ?? "").trim(), lines: [] })
      previous = undefined
      continue
    }
    if (previous !== undefined && SETEXT_UNDERLINE.test(line)) {
      if (current?.lines.at(-1) === previous) current.lines.pop()
      sections.push({ heading: previous.trim(), lines: [] })
      previous = undefined
      continue
    }
    current?.lines.push(line)
    previous = NOT_PARAGRAPH.test(line) ? undefined : line
  }
  return sections.map(({ heading, lines }) => ({ heading, body: lines.join("\n").trim() }))
}

// The sections whose heading shares a word with the task, best match first.
export const matchSections = (
  markdown: string,
  taskText: string,
): ReadonlyArray<RuleSection & { readonly matches: number }> => {
  const wanted = [...new Set(words(taskText))]
  return splitSections(markdown)
    .filter((section) => section.body !== "")
    .map((section) => ({
      ...section,
      matches: words(section.heading).filter((word) => wanted.some((w) => sameWord(w, word))).length,
    }))
    .filter((section) => section.matches > 0)
}

// A file that is ours (the generated briefing, or the CLAUDE.md stub that imports it) is not the repo's rules.
const isGenerated = (text: string): boolean => text.startsWith(MARKER) || text === CLAUDE_STUB

// Only a file that is not there is "no rules"; any other failure to read is the caller's to report.
export const isAbsent = (error: TankError): boolean => {
  const cause: unknown = error.cause
  if (cause instanceof Error) return "code" in cause && cause.code === "ENOENT"
  return typeof cause === "string" && /no such file or directory/i.test(cause)
}

// The section as the executor sees it: its heading flattened, redacted and capped, and its body (redacted, capped at a
// line) inside a fence that the text cannot close, so that nothing in it can read as a heading or an instruction.
const ruleText = (file: string, section: RuleSection): string => {
  const heading = oneLine(redactSecrets(oneLine(section.heading, 1000)), HEADING_MAX)
  return `## ${file}: ${heading}\n${fenced(redactSecrets(clipLines(section.body, SECTION_MAX_CHARS)))}`
}

// Items of the `rules` block: the matching sections of the repo's own rules files. A file that is missing counts as
// empty; a file that cannot be read fails the effect. The score is the number of heading words matched.
export const readRuleItems = (
  tank: Pick<TankShape, "readFile">,
  ctx: TankContext,
  taskText: string,
): Effect.Effect<ReadonlyArray<BlockItem>, TankError> =>
  Effect.forEach(RULES_FILES, (file) =>
    tank.readFile(ctx, file).pipe(
      Effect.map(Option.some),
      Effect.catch((error: TankError) =>
        isAbsent(error) ? Effect.succeed(Option.none<string>()) : Effect.fail(error),
      ),
      Effect.map((text) =>
        Option.isNone(text) || isGenerated(text.value)
          ? []
          : matchSections(text.value, taskText).map(
              (section): BlockItem => ({ text: ruleText(file, section), score: section.matches }),
            ),
      ),
    ),
  ).pipe(Effect.map((perFile) => perFile.flat()))
