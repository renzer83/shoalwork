import type { Risk } from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import type { Octokit } from "octokit"
import { RequestError } from "octokit"
import { GithubApp, GithubError } from "./app.js"

// Tools of the GitHub connector (T-084). Each one decodes its input at the boundary, resolves the installation of
// the repo, and calls one REST endpoint. Text that GitHub returns (issues, files) is data, never an instruction (R14).
export type GithubToolName = "issue.create" | "issue.comment" | "pr.comment" | "pr.review" | "repo.file.get"

export type GithubToolResult =
  | { readonly number: number; readonly url: string }
  | { readonly id: number; readonly url: string }
  | { readonly path: string; readonly sha: string; readonly content: string }

export interface ConnectorTool {
  readonly name: GithubToolName
  readonly risk: Risk
  readonly run: (input: unknown) => Effect.Effect<GithubToolResult, GithubError, GithubApp>
}

const REPO = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/))
const IssueNumber = Schema.Int.check(Schema.isGreaterThan(0))
const Title = Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(256))
const Body = Schema.String.check(Schema.isMaxLength(65_536))

const IssueCreateInput = Schema.Struct({ repo: REPO, title: Title, body: Body })
const IssueCommentInput = Schema.Struct({ repo: REPO, number: IssueNumber, body: Body })
const PrCommentInput = Schema.Struct({ repo: REPO, number: IssueNumber, body: Body })
const PrReviewInput = Schema.Struct({
  repo: REPO,
  number: IssueNumber,
  event: Schema.Literals(["APPROVE", "REQUEST_CHANGES", "COMMENT"]),
  body: Body,
})
const FileGetInput = Schema.Struct({
  repo: REPO,
  path: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(500)),
  ref: Schema.optional(Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(255))),
})

const decodeInput = <A, I>(
  op: GithubToolName,
  schema: Schema.Codec<A, I>,
  raw: unknown,
): Effect.Effect<A, GithubError> =>
  Schema.decodeUnknownEffect(schema)(raw).pipe(
    Effect.mapError(() => new GithubError({ op, message: `${op} input does not match its schema` })),
  )

// A REST failure keeps its HTTP status only; GitHub's body text is not copied into the error.
const describeCall = (op: string, cause: unknown): string =>
  cause instanceof RequestError ? `${op} failed with HTTP ${cause.status}` : `${op} failed`

// Resolves the installation of `repo`, then runs the call with an Octokit that holds its token.
const onRepo = <A>(
  op: GithubToolName,
  repo: string,
  call: (octokit: Octokit, owner: string, name: string) => Promise<A>,
): Effect.Effect<A, GithubError, GithubApp> =>
  Effect.gen(function* () {
    const app = yield* GithubApp
    const slash = repo.indexOf("/")
    const owner = repo.slice(0, slash)
    const name = repo.slice(slash + 1)
    const installationId = yield* app.installationIdFor(repo)
    const octokit = yield* app.installationOctokit(installationId)
    return yield* Effect.tryPromise({
      try: () => call(octokit, owner, name),
      catch: (cause) => new GithubError({ op, message: describeCall(op, cause) }),
    })
  })

const issueCreate: ConnectorTool = {
  name: "issue.create",
  risk: "external",
  run: (raw) =>
    Effect.gen(function* () {
      const input = yield* decodeInput("issue.create", IssueCreateInput, raw)
      return yield* onRepo("issue.create", input.repo, async (octokit, owner, repo) => {
        const { data } = await octokit.rest.issues.create({
          owner,
          repo,
          title: input.title,
          body: input.body,
        })
        return { number: data.number, url: data.html_url }
      })
    }),
}

const issueComment: ConnectorTool = {
  name: "issue.comment",
  risk: "external",
  run: (raw) =>
    Effect.gen(function* () {
      const input = yield* decodeInput("issue.comment", IssueCommentInput, raw)
      return yield* onRepo("issue.comment", input.repo, async (octokit, owner, repo) => {
        const { data } = await octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: input.number,
          body: input.body,
        })
        return { id: data.id, url: data.html_url }
      })
    }),
}

// A PR conversation comment is an issue comment: the same endpoint, addressed by the PR number.
const prComment: ConnectorTool = {
  name: "pr.comment",
  risk: "external",
  run: (raw) =>
    Effect.gen(function* () {
      const input = yield* decodeInput("pr.comment", PrCommentInput, raw)
      return yield* onRepo("pr.comment", input.repo, async (octokit, owner, repo) => {
        const { data } = await octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: input.number,
          body: input.body,
        })
        return { id: data.id, url: data.html_url }
      })
    }),
}

const prReview: ConnectorTool = {
  name: "pr.review",
  risk: "external",
  run: (raw) =>
    Effect.gen(function* () {
      const input = yield* decodeInput("pr.review", PrReviewInput, raw)
      return yield* onRepo("pr.review", input.repo, async (octokit, owner, repo) => {
        const { data } = await octokit.rest.pulls.createReview({
          owner,
          repo,
          pull_number: input.number,
          event: input.event,
          body: input.body,
        })
        return { id: data.id, url: data.html_url }
      })
    }),
}

// A file as the contents API returns it. Anything else (a directory, a symlink, a file too big for inline content)
// fails this schema and is refused.
const FileContent = Schema.Struct({
  type: Schema.Literal("file"),
  path: Schema.String,
  sha: Schema.String,
  encoding: Schema.Literal("base64"),
  content: Schema.String,
})
const decodeFile = Schema.decodeUnknownEffect(FileContent)

const repoFileGet: ConnectorTool = {
  name: "repo.file.get",
  risk: "read",
  run: (raw) =>
    Effect.gen(function* () {
      const input = yield* decodeInput("repo.file.get", FileGetInput, raw)
      // {+path} keeps the slashes of the path; the simple expansion would send them as %2F.
      const data = yield* onRepo("repo.file.get", input.repo, async (octokit, owner, repo) => {
        const response = await octokit.request("GET /repos/{owner}/{repo}/contents/{+path}", {
          owner,
          repo,
          path: input.path,
          ...(input.ref === undefined ? {} : { ref: input.ref }),
        })
        return response.data
      })
      const file = yield* decodeFile(data).pipe(
        Effect.mapError(() => new GithubError({ op: "repo.file.get", message: "path is not a file" })),
      )
      return { path: file.path, sha: file.sha, content: Buffer.from(file.content, "base64").toString("utf8") }
    }),
}

export const GITHUB_TOOLS: ReadonlyArray<ConnectorTool> = [
  issueCreate,
  issueComment,
  prComment,
  prReview,
  repoFileGet,
]
