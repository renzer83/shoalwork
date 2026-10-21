import { it } from "@effect/vitest"
import { withTempDb } from "@shoalwork/db/testing"
import { Effect, Redacted } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import { GithubApp, GithubError, makeGithubApp } from "../../src/github/app.js"
import { githubConnector } from "../../src/github/connector.js"
import { GITHUB_TOOLS, type GithubToolName } from "../../src/github/tools.js"
import { fakeGitHub, PRIVATE_KEY, type Reply, type Sent, T0 } from "./app-support.js"

const REPO = "renzer83/shoalwork-sandbox"
const API = "https://api.github.com/repos/renzer83/shoalwork-sandbox"

const toolNamed = (name: GithubToolName) => {
  const found = GITHUB_TOOLS.find((tool) => tool.name === name)
  if (found === undefined) throw new Error(`no tool ${name}`)
  return found
}

// Every REST call answers with a small object that has the fields the tools read.
const answerAll = (sent: Sent): Reply => {
  if (sent.url.includes("/contents/")) {
    return {
      status: 200,
      body: {
        type: "file",
        path: "src/sum.ts",
        sha: "abc123",
        encoding: "base64",
        content: Buffer.from("export const sum = (a: number, b: number) => a + b\n").toString("base64"),
      },
    }
  }
  return {
    status: 201,
    body: { id: 9, number: 3, html_url: "https://github.com/renzer83/shoalwork-sandbox/issues/3" },
  }
}

const seed = (sql: SqlClient) =>
  sql`INSERT INTO github_installations (installation_id, account, repos) VALUES (42, 'renzer83', ${JSON.stringify([REPO])})
    ON CONFLICT(installation_id) DO UPDATE SET repos = excluded.repos`.pipe(Effect.orDie)

// The tools run against the real App service, with the GitHub stand-in behind its fetch.
const withApp = (sql: SqlClient, answer: (sent: Sent) => Reply = answerAll) => {
  const clock = { now: T0 }
  const gh = fakeGitHub(clock, answer)
  const app = makeGithubApp(
    { appId: "12345", privateKey: Redacted.make(PRIVATE_KEY), fetch: gh.fetch, now: () => clock.now },
    sql,
  )
  return {
    gh,
    provide: <A, E, R>(eff: Effect.Effect<A, E, R | GithubApp>) =>
      eff.pipe(Effect.provideService(GithubApp, app)),
  }
}

describe("GitHub tools", () => {
  it.layer(withTempDb())("each tool calls its endpoint with the installation token", (it) => {
    it.effect("issue.create posts the issue to the repo's issues endpoint", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient
        yield* seed(sql)
        const { gh, provide } = withApp(sql)
        const result = yield* provide(
          toolNamed("issue.create").run({ repo: REPO, title: "Add sum", body: "Details" }),
        )
        expect(result).toEqual({ number: 3, url: "https://github.com/renzer83/shoalwork-sandbox/issues/3" })
        expect(gh.sent.find((sent) => sent.url === `${API}/issues`)).toMatchObject({
          method: "POST",
          authorization: "token ghs_1",
          body: { title: "Add sum", body: "Details" },
        })
      }),
    )

    it.effect("issue.comment posts to the comments of the issue", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient
        yield* seed(sql)
        const { gh, provide } = withApp(sql)
        const result = yield* provide(
          toolNamed("issue.comment").run({ repo: REPO, number: 7, body: "On it" }),
        )
        expect(result).toEqual({ id: 9, url: "https://github.com/renzer83/shoalwork-sandbox/issues/3" })
        expect(gh.sent.find((sent) => sent.url === `${API}/issues/7/comments`)).toMatchObject({
          method: "POST",
          body: { body: "On it" },
        })
      }),
    )

    it.effect("pr.comment posts to the conversation of the PR (an issue comment)", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient
        yield* seed(sql)
        const { gh, provide } = withApp(sql)
        yield* provide(toolNamed("pr.comment").run({ repo: REPO, number: 9, body: "LGTM with a nit" }))
        expect(gh.sent.find((sent) => sent.url === `${API}/issues/9/comments`)).toMatchObject({
          method: "POST",
          body: { body: "LGTM with a nit" },
        })
      }),
    )

    it.effect("pr.review posts a review with the chosen event", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient
        yield* seed(sql)
        const { gh, provide } = withApp(sql)
        yield* provide(
          toolNamed("pr.review").run({
            repo: REPO,
            number: 9,
            event: "REQUEST_CHANGES",
            body: "Fix the test",
          }),
        )
        expect(gh.sent.find((sent) => sent.url === `${API}/pulls/9/reviews`)).toMatchObject({
          method: "POST",
          body: { event: "REQUEST_CHANGES", body: "Fix the test" },
        })
      }),
    )

    it.effect("repo.file.get reads a file at a ref and decodes its content", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient
        yield* seed(sql)
        const { gh, provide } = withApp(sql)
        const result = yield* provide(
          toolNamed("repo.file.get").run({ repo: REPO, path: "src/sum.ts", ref: "main" }),
        )
        expect(result).toEqual({
          path: "src/sum.ts",
          sha: "abc123",
          content: "export const sum = (a: number, b: number) => a + b\n",
        })
        expect(gh.sent.find((sent) => sent.url.startsWith(`${API}/contents/src/sum.ts`))).toMatchObject({
          method: "GET",
          authorization: "token ghs_1",
        })
        expect(gh.sent.find((sent) => sent.url.startsWith(`${API}/contents/src/sum.ts`))?.url).toContain(
          "ref=main",
        )
      }),
    )

    it.effect("an input that does not match its schema is refused before any request", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient
        yield* seed(sql)
        const { gh, provide } = withApp(sql)
        const failure = yield* Effect.flip(
          provide(toolNamed("issue.create").run({ repo: REPO, title: "", body: "" })),
        )
        expect(failure).toBeInstanceOf(GithubError)
        expect(failure.op).toBe("issue.create")
        expect(gh.sent.filter((sent) => !sent.url.endsWith("/access_tokens"))).toEqual([])
      }),
    )

    it.effect("a repo no installation covers is refused before any request", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient
        yield* seed(sql)
        const { gh, provide } = withApp(sql)
        const failure = yield* Effect.flip(
          provide(toolNamed("issue.comment").run({ repo: "someone/else", number: 1, body: "hi" })),
        )
        expect(failure.message).toBe("no installation covers someone/else")
        expect(gh.sent).toEqual([])
      }),
    )

    it.effect("a REST failure names the operation and the HTTP status, never GitHub's body", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient
        yield* seed(sql)
        const { provide } = withApp(sql, () => ({ status: 422, body: { message: "secret detail ghs_leak" } }))
        const failure = yield* Effect.flip(
          provide(toolNamed("issue.create").run({ repo: REPO, title: "Add sum", body: "" })),
        )
        expect(failure.message).toBe("issue.create failed with HTTP 422")
        expect(failure.message).not.toContain("ghs_leak")
      }),
    )
  })

  it("github connector lists its five tools with their risk and its five triggers", () => {
    expect(githubConnector.id).toBe("github")
    expect(githubConnector.permissions).toEqual([
      { tool: "issue.create", risk: "external" },
      { tool: "issue.comment", risk: "external" },
      { tool: "pr.comment", risk: "external" },
      { tool: "pr.review", risk: "external" },
      { tool: "repo.file.get", risk: "read" },
    ])
    expect(githubConnector.tools.map((tool) => tool.name)).toEqual(
      githubConnector.permissions.map((p) => p.tool),
    )
    expect(githubConnector.triggers).toEqual([
      "github.issues",
      "github.pull_request",
      "github.workflow_run",
      "github.check_suite",
      "github.push",
    ])
  })
})
