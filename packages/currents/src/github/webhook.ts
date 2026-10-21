import { createHmac, timingSafeEqual } from "node:crypto"
import { Data, Effect, Schema } from "effect"

// Third-party text is cut before any pattern runs, so a hostile body cannot make the scans slow (T-040 rule).
const SCAN_LIMIT = 2_000
const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:gh[pousr]_|github_pat_|sk-(?:ant|proj|live)[-_])[A-Za-z0-9_-]{8,}/g,
  /\b\d{5,}:[A-Za-z0-9_-]{20,}/g,
]
// Controls (line breaks included), format characters (bidi overrides and isolates among them): none belongs in a
// title, a name or a URL. Replaced by a space, so words stay apart.
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}]/gu

// Third-party text is data: controls and bidi removed, token-shaped strings redacted, cut to max characters.
export const cleanText = (text: string, max: number): string => {
  let out = text.slice(0, SCAN_LIMIT).replace(UNSAFE_CHARS, " ").replace(/\s+/g, " ")
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[redacted]")
  }
  return out.trim().slice(0, max)
}

// A URL from GitHub is kept only when it is plain https without credentials; anything else takes the fallback.
export const httpsUrl = (value: string | undefined, fallback: string): string => {
  if (value === undefined) return fallback
  const cleaned = cleanText(value, 300)
  try {
    const url = new URL(cleaned)
    return url.protocol === "https:" && url.username === "" && url.password === "" ? cleaned : fallback
  } catch (_error) {
    // Not a URL at all: the fallback is the answer, nothing is logged.
    return fallback
  }
}

// X-Hub-Signature-256 is "sha256=" plus the HMAC of the RAW body. Compared in constant time; a length mismatch
// is refused before the comparison. Official vector: secret "It's a Secret to Everybody", body "Hello, World!".
export const verifyGithubSignature = (
  secret: string,
  rawBody: Uint8Array,
  header: string | undefined,
): boolean => {
  if (header === undefined) return false
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`)
  const given = Buffer.from(header)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

export class GithubPayloadError extends Data.TaggedError("GithubPayloadError")<{
  readonly event: string
  readonly message: string
}> {}

export type GithubEventType =
  | "github.issues"
  | "github.pull_request"
  | "github.workflow_run"
  | "github.check_suite"
  | "github.push"

export interface GithubEvent {
  readonly type: GithubEventType
  readonly actor: string
  readonly payload: Record<string, unknown>
}

export type GithubReduction =
  | { readonly _tag: "event"; readonly event: GithubEvent }
  | { readonly _tag: "ignored"; readonly name: string }

// A Bot names its worktree branch bot/<bot>/<step> (tank). Its own work is that branch AND a head in this very repo:
// a PR from a fork that happens to use the same branch name is someone else's.
const BOT_BRANCH = /^bot\/[^/]+\/step_/
export const isBotBranch = (branch: string | undefined): boolean =>
  branch !== undefined && BOT_BRANCH.test(branch)

const REPO_NAME = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$/

const senderOf = (login: string): string => {
  const cleaned = cleanText(login, 64)
  return LOGIN.test(cleaned) ? cleaned : "unknown"
}

const HeadRepo = Schema.NullOr(Schema.Struct({ full_name: Schema.String }))
const sameRepo = (head: { readonly full_name: string } | null | undefined, repo: string): boolean =>
  head !== undefined && head !== null && head.full_name.toLowerCase() === repo.toLowerCase()

const RepoIn = Schema.Struct({
  full_name: Schema.String.check(Schema.isPattern(REPO_NAME)),
  html_url: Schema.optional(Schema.String),
})
const SenderIn = Schema.Struct({ login: Schema.String })
const NullableText = Schema.optional(Schema.NullOr(Schema.String))

const IssuesIn = Schema.Struct({
  action: Schema.String,
  repository: RepoIn,
  sender: SenderIn,
  issue: Schema.Struct({
    number: Schema.Int,
    title: Schema.String,
    state: Schema.optional(Schema.String),
    html_url: Schema.optional(Schema.String),
    labels: Schema.optional(
      Schema.Array(Schema.Union([Schema.String, Schema.Struct({ name: Schema.optional(Schema.String) })])),
    ),
  }),
})

const PullRequestIn = Schema.Struct({
  action: Schema.String,
  repository: RepoIn,
  sender: SenderIn,
  pull_request: Schema.Struct({
    number: Schema.Int,
    title: Schema.String,
    state: Schema.optional(Schema.String),
    html_url: Schema.optional(Schema.String),
    merged: Schema.optional(Schema.Boolean),
    head: Schema.Struct({ ref: Schema.String, repo: Schema.optional(HeadRepo) }),
  }),
})

const WorkflowRunIn = Schema.Struct({
  action: Schema.String,
  repository: RepoIn,
  sender: SenderIn,
  workflow_run: Schema.Struct({
    name: Schema.optional(Schema.NullOr(Schema.String)),
    head_branch: NullableText,
    head_repository: Schema.optional(HeadRepo),
    conclusion: NullableText,
    html_url: Schema.optional(Schema.String),
  }),
})

const CheckSuiteIn = Schema.Struct({
  action: Schema.String,
  repository: RepoIn,
  sender: SenderIn,
  check_suite: Schema.Struct({
    head_branch: NullableText,
    head_repository: Schema.optional(HeadRepo),
    conclusion: NullableText,
  }),
})

const PushIn = Schema.Struct({
  ref: Schema.String,
  deleted: Schema.optional(Schema.Boolean),
  repository: RepoIn,
  sender: SenderIn,
})

const nonEmpty = (value: string | null | undefined): string | undefined =>
  value === undefined || value === null || value === "" ? undefined : value

const optionalText = (key: string, value: string | undefined, max: number): Record<string, string> =>
  value === undefined ? {} : { [key]: cleanText(value, max) }

// Label names of an issue, cleaned and capped. A label is third-party text (R14): it is data, never an instruction.
// The board reads it to know if an issue may run (T-060).
const labelNames = (
  labels: ReadonlyArray<string | { readonly name?: string | undefined }> | undefined,
): Record<string, ReadonlyArray<string>> => {
  if (labels === undefined) return {}
  const names = labels
    .map((label) => (typeof label === "string" ? label : (label.name ?? "")))
    .map((name) => cleanText(name, 50))
    .filter((name) => name !== "")
  return names.length === 0 ? {} : { labels: names }
}

const fail = (event: string) => () =>
  new GithubPayloadError({ event, message: "payload does not match the expected GitHub shape" })

const decode = <A, I>(schema: Schema.Codec<A, I>, value: unknown, event: string) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(fail(event)))

const event = (type: GithubEventType, login: string, payload: Record<string, unknown>): GithubReduction => ({
  _tag: "event",
  event: { type, actor: `github:${senderOf(login)}`, payload },
})

// Minimal event per supported X-GitHub-Event. Unsupported events are ignored, not errors. Malformed bodies fail.
export const reduceGithubDelivery = (
  eventName: string,
  rawBody: string,
  deliveryId: string,
): Effect.Effect<GithubReduction, GithubPayloadError> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => {
        const value: unknown = JSON.parse(rawBody)
        return value
      },
      catch: fail(eventName),
    })
    const base = (repo: string, login: string, url: string, botAuthored: boolean, action: string) => ({
      deliveryId,
      repo,
      sender: senderOf(login),
      url,
      botAuthored,
      action: cleanText(action, 40),
    })
    switch (eventName) {
      case "issues": {
        const body = yield* decode(IssuesIn, parsed, eventName)
        const { issue, repository, sender } = body
        return event("github.issues", sender.login, {
          ...base(
            repository.full_name,
            sender.login,
            httpsUrl(issue.html_url, `https://github.com/${repository.full_name}`),
            false,
            body.action,
          ),
          number: issue.number,
          title: cleanText(issue.title, 200),
          ...optionalText("state", issue.state, 30),
          ...labelNames(issue.labels),
        })
      }
      case "pull_request": {
        const body = yield* decode(PullRequestIn, parsed, eventName)
        const { pull_request: pr, repository, sender } = body
        const botAuthored = isBotBranch(pr.head.ref) && sameRepo(pr.head.repo, repository.full_name)
        return event("github.pull_request", sender.login, {
          ...base(
            repository.full_name,
            sender.login,
            httpsUrl(pr.html_url, `https://github.com/${repository.full_name}`),
            botAuthored,
            body.action,
          ),
          number: pr.number,
          title: cleanText(pr.title, 200),
          headBranch: cleanText(pr.head.ref, 200),
          ...optionalText("state", pr.state, 30),
          ...(pr.merged === true ? { merged: true } : {}),
        })
      }
      case "workflow_run": {
        const body = yield* decode(WorkflowRunIn, parsed, eventName)
        const { workflow_run: run, repository, sender } = body
        const botAuthored =
          isBotBranch(run.head_branch ?? undefined) && sameRepo(run.head_repository, repository.full_name)
        return event("github.workflow_run", sender.login, {
          ...base(
            repository.full_name,
            sender.login,
            httpsUrl(run.html_url, `https://github.com/${repository.full_name}`),
            botAuthored,
            body.action,
          ),
          ...optionalText("title", nonEmpty(run.name), 200),
          ...optionalText("headBranch", nonEmpty(run.head_branch), 200),
          ...optionalText("conclusion", nonEmpty(run.conclusion), 50),
        })
      }
      case "check_suite": {
        const body = yield* decode(CheckSuiteIn, parsed, eventName)
        const { check_suite: suite, repository, sender } = body
        const botAuthored =
          isBotBranch(suite.head_branch ?? undefined) && sameRepo(suite.head_repository, repository.full_name)
        return event("github.check_suite", sender.login, {
          ...base(
            repository.full_name,
            sender.login,
            httpsUrl(repository.html_url, `https://github.com/${repository.full_name}`),
            botAuthored,
            body.action,
          ),
          ...optionalText("headBranch", nonEmpty(suite.head_branch), 200),
          ...optionalText("conclusion", nonEmpty(suite.conclusion), 50),
        })
      }
      case "push": {
        const body = yield* decode(PushIn, parsed, eventName)
        const branch = body.ref.startsWith("refs/heads/") ? body.ref.slice("refs/heads/".length) : undefined
        return event("github.push", body.sender.login, {
          ...base(
            body.repository.full_name,
            body.sender.login,
            httpsUrl(body.repository.html_url, `https://github.com/${body.repository.full_name}`),
            isBotBranch(branch),
            body.deleted === true ? "deleted" : "pushed",
          ),
          ref: cleanText(body.ref, 200),
        })
      }
      default:
        return { _tag: "ignored", name: eventName } as const
    }
  })
