import { Effect } from "effect"
import { isIgnoredPath, looksLikeSecret } from "../indexer/walk.js"
import { GitIntelError, runGit } from "./run.js"

export { GitIntelError } from "./run.js"

export const RECENT_COMMITS_MAX = 20
export const RELATED_DIFF_COMMITS = 3
const FIELD_SEP = "\x1f"
const REDACTED = "[redacted]"
const SUBJECT_MAX = 300
const NAME_MAX = 200
const EMAIL = /[^\s<>@]+@[^\s<>@]+/g
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/

export interface RecentCommit {
  readonly sha: string
  readonly date: string // ISO-8601 committer date
  readonly author: string // name only: e-mail addresses never leave git
  readonly subject: string
  readonly files: ReadonlyArray<string>
}

export interface RelatedDiff {
  readonly sha: string
  readonly path: string
  readonly patch: string
}

export interface BlameSummary {
  readonly authors: ReadonlyArray<{ readonly name: string; readonly lines: number }>
  readonly lastChange: string // ISO-8601 of the last commit touching the path, "" when git has none
}

// Untrusted text from history (R14): clipped first so that the e-mail rule runs on a short string, then screened.
const cleanText = (text: string, max: number): string => {
  const clipped = text.slice(0, max)
  return looksLikeSecret(clipped) ? REDACTED : clipped.replace(EMAIL, "[email]")
}

const uniquePaths = (paths: ReadonlyArray<string>): Array<string> => [
  ...new Set(paths.filter((path) => path !== "")),
]

const windowOk = (days: number): boolean => Number.isInteger(days) && days > 0
const DAY_MS = 86_400_000

// An absolute cutoff: git reads `--since=30d` as the 30th day of the month (`14d` happens to work), so it is not used.
const sinceIso = (days: number): string => new Date(Date.now() - days * DAY_MS).toISOString()

const FORMAT = `--format=%H${FIELD_SEP}%cI${FIELD_SEP}%an${FIELD_SEP}%s`

interface PendingCommit {
  readonly sha: string
  readonly date: string
  readonly author: string
  readonly subject: string
  readonly files: Array<string>
}

// `--name-only` output: a header line per commit (fields separated by FIELD_SEP), then its file names.
const parseRecent = (stdout: string): Array<RecentCommit> => {
  const commits: Array<PendingCommit> = []
  for (const line of stdout.split("\n")) {
    const fields = line.split(FIELD_SEP)
    const [sha, date, author] = fields
    if (fields.length >= 4 && sha !== undefined && SHA.test(sha)) {
      commits.push({
        sha,
        date: cleanText(date ?? "", 40),
        author: cleanText(author ?? "", NAME_MAX),
        subject: cleanText(fields.slice(3).join(FIELD_SEP), SUBJECT_MAX),
        files: [],
      })
      continue
    }
    const current = commits[commits.length - 1]
    if (current !== undefined && line !== "" && !isIgnoredPath(line)) current.files.push(line)
  }
  return commits.map(({ files, ...commit }) => ({ ...commit, files }))
}

// Commits of the last `days` days that touched any of `paths`, newest first, at most RECENT_COMMITS_MAX. No paths, no
// history: an empty pathspec would list the whole repository, so it lists nothing.
export const recentChanges = (
  repoDir: string,
  paths: ReadonlyArray<string>,
  days: number,
): Effect.Effect<ReadonlyArray<RecentCommit>, GitIntelError> => {
  const scope = uniquePaths(paths)
  if (scope.length === 0) return Effect.succeed([])
  if (!windowOk(days)) {
    return Effect.fail(new GitIntelError({ reason: "invalid", detail: "days must be a positive integer" }))
  }
  return runGit(repoDir, [
    "log",
    `--since=${sinceIso(days)}`,
    `--max-count=${RECENT_COMMITS_MAX}`,
    FORMAT,
    "--name-only",
    "--",
    ...scope,
  ]).pipe(Effect.map(parseRecent))
}

// Hunks of one path's patch, in order, without the file header. Blank separators between commits are dropped.
const hunksOf = (lines: ReadonlyArray<string>): Array<Array<string>> => {
  const hunks: Array<Array<string>> = []
  for (const line of lines) {
    if (line.startsWith("@@")) hunks.push([line])
    else hunks[hunks.length - 1]?.push(line)
  }
  return hunks.map((hunk) => {
    while (hunk.length > 0 && hunk[hunk.length - 1] === "") hunk.pop()
    return hunk
  })
}

// Whole hunks while they fit `maxLines`; a first hunk longer than that is cut to its first lines. A hunk that looks
// like a secret is left out, never shown.
const fitHunks = (hunks: ReadonlyArray<ReadonlyArray<string>>, maxLines: number): Array<string> => {
  const kept: Array<string> = []
  for (const hunk of hunks) {
    if (looksLikeSecret(hunk.join("\n"))) continue
    if (kept.length + hunk.length > maxLines) {
      if (kept.length === 0) kept.push(...hunk.slice(0, maxLines))
      break
    }
    kept.push(...hunk)
  }
  return kept
}

// The patch of `path` in each of its last RELATED_DIFF_COMMITS commits, cut to `maxLines` lines per commit.
export const relatedDiffs = (
  repoDir: string,
  paths: ReadonlyArray<string>,
  maxLines: number,
): Effect.Effect<ReadonlyArray<RelatedDiff>, GitIntelError> => {
  if (!Number.isInteger(maxLines) || maxLines < 1) {
    return Effect.fail(
      new GitIntelError({ reason: "invalid", detail: "maxLines must be a positive integer" }),
    )
  }
  return Effect.forEach(
    uniquePaths(paths),
    (path) =>
      runGit(repoDir, [
        "log",
        `-${RELATED_DIFF_COMMITS}`,
        "-p",
        "--format=%H",
        "--no-ext-diff",
        "--no-textconv",
        "--",
        path,
      ]).pipe(
        Effect.map((stdout) => {
          const out: Array<RelatedDiff> = []
          let sha: string | undefined
          let lines: Array<string> = []
          const flush = () => {
            if (sha === undefined) return
            const patch = fitHunks(hunksOf(lines), maxLines)
            if (patch.length > 0) out.push({ sha, path, patch: patch.join("\n") })
          }
          for (const line of stdout.split("\n")) {
            if (SHA.test(line)) {
              flush()
              sha = line
              lines = []
            } else {
              lines.push(line)
            }
          }
          flush()
          return out
        }),
      ),
    { concurrency: 1 },
  ).pipe(Effect.map((groups) => groups.flat()))
}

// Lines per author of `path` (from `blame --line-porcelain`) and the date of its last commit.
export const blameSummary = (repoDir: string, path: string): Effect.Effect<BlameSummary, GitIntelError> =>
  Effect.gen(function* () {
    const porcelain = yield* runGit(repoDir, ["blame", "--line-porcelain", "--", path])
    const counts = new Map<string, number>()
    for (const line of porcelain.split("\n")) {
      if (!line.startsWith("author ")) continue
      const name = cleanText(line.slice("author ".length), NAME_MAX)
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    const last = yield* runGit(repoDir, ["log", "-1", "--format=%cI", "--", path])
    const authors = [...counts]
      .map(([name, lines]) => ({ name, lines }))
      .sort((a, b) => b.lines - a.lines || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return { authors, lastChange: cleanText(last.trim(), 40) }
  })
