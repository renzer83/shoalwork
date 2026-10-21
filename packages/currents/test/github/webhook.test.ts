import { createHmac } from "node:crypto"
import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import {
  cleanText,
  GithubPayloadError,
  httpsUrl,
  isBotBranch,
  reduceGithubDelivery,
  verifyGithubSignature,
} from "../../src/github/webhook.js"

const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/github/${name}`, import.meta.url), "utf8")

const DELIVERY = "5f0c2a7e-1111-4a2b-9c3d-000000000001"

// GitHub's documented example: secret "It's a Secret to Everybody", body "Hello, World!".
const VECTOR_SECRET = "It's a Secret to Everybody"
const VECTOR_BODY = Buffer.from("Hello, World!")
const VECTOR_SIGNATURE = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17"

describe("verifyGithubSignature", () => {
  it("accepts the official vector", () => {
    expect(verifyGithubSignature(VECTOR_SECRET, VECTOR_BODY, VECTOR_SIGNATURE)).toBe(true)
  })

  it("rejects a body that differs by one byte", () => {
    expect(verifyGithubSignature(VECTOR_SECRET, Buffer.from("Hello, World?"), VECTOR_SIGNATURE)).toBe(false)
  })

  it("rejects a wrong secret, a missing header, and a header of another length", () => {
    expect(verifyGithubSignature("other", VECTOR_BODY, VECTOR_SIGNATURE)).toBe(false)
    expect(verifyGithubSignature(VECTOR_SECRET, VECTOR_BODY, undefined)).toBe(false)
    expect(verifyGithubSignature(VECTOR_SECRET, VECTOR_BODY, "sha256=00")).toBe(false)
    expect(verifyGithubSignature(VECTOR_SECRET, VECTOR_BODY, "")).toBe(false)
  })

  it("signs the raw bytes: a re-serialised body with the same JSON fails", () => {
    const raw = Buffer.from('{"a": 1}')
    const reserialised = Buffer.from(JSON.stringify(JSON.parse('{"a": 1}')))
    const signature = `sha256=${createHmac("sha256", "s").update(raw).digest("hex")}`
    expect(verifyGithubSignature("s", raw, signature)).toBe(true)
    expect(verifyGithubSignature("s", reserialised, signature)).toBe(false)
  })
})

describe("reduceGithubDelivery", () => {
  it.effect("maps the issues fixture to a minimal github.issues event without the body", () =>
    Effect.gen(function* () {
      const reduced = yield* reduceGithubDelivery("issues", fixture("issues.json"), DELIVERY)
      expect(reduced).toEqual({
        _tag: "event",
        event: {
          type: "github.issues",
          actor: "github:renzer83",
          payload: {
            deliveryId: DELIVERY,
            repo: "renzer83/shoalwork-sandbox",
            sender: "renzer83",
            url: "https://github.com/renzer83/shoalwork-sandbox/issues/3",
            botAuthored: false,
            action: "opened",
            number: 3,
            title: "Add sum helper",
            state: "open",
            labels: ["enhancement"],
          },
        },
      })
      expect(JSON.stringify(reduced)).not.toContain("Full issue body")
    }),
  )

  it.effect("maps the pull_request fixture and flags a PR from a Bot branch as the Bot's own", () =>
    Effect.gen(function* () {
      const reduced = yield* reduceGithubDelivery("pull_request", fixture("pull_request.json"), DELIVERY)
      expect(reduced).toMatchObject({
        _tag: "event",
        event: {
          type: "github.pull_request",
          payload: {
            action: "opened",
            number: 7,
            title: "Add sum helper",
            state: "open",
            headBranch: "bot/dev-demo/step_00000000-0000-4000-8000-000000000002",
            botAuthored: true,
          },
        },
      })
    }),
  )

  it.effect("maps the workflow_run fixture with conclusion and branch", () =>
    Effect.gen(function* () {
      const reduced = yield* reduceGithubDelivery("workflow_run", fixture("workflow_run.json"), DELIVERY)
      expect(reduced).toMatchObject({
        _tag: "event",
        event: {
          type: "github.workflow_run",
          payload: {
            action: "completed",
            title: "CI",
            headBranch: "main",
            conclusion: "success",
            botAuthored: false,
          },
        },
      })
    }),
  )

  it.effect("maps the check_suite fixture; a bot sender is kept as its login", () =>
    Effect.gen(function* () {
      const reduced = yield* reduceGithubDelivery("check_suite", fixture("check_suite.json"), DELIVERY)
      expect(reduced).toMatchObject({
        _tag: "event",
        event: {
          type: "github.check_suite",
          actor: "github:github-actions[bot]",
          payload: { conclusion: "failure", botAuthored: true },
        },
      })
    }),
  )

  it.effect("maps the push fixture to github.push with the ref", () =>
    Effect.gen(function* () {
      const reduced = yield* reduceGithubDelivery("push", fixture("push.json"), DELIVERY)
      expect(reduced).toMatchObject({
        _tag: "event",
        event: {
          type: "github.push",
          payload: { action: "pushed", ref: "refs/heads/main", botAuthored: false },
        },
      })
    }),
  )

  it.effect("ignores an event it does not handle", () =>
    Effect.gen(function* () {
      const reduced = yield* reduceGithubDelivery("star", "{}", DELIVERY)
      expect(reduced).toEqual({ _tag: "ignored", name: "star" })
    }),
  )

  it.effect("fails on a body that is not JSON, without echoing it", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(reduceGithubDelivery("push", "not json secret-value", DELIVERY))
      expect(failure).toBeInstanceOf(GithubPayloadError)
      expect(failure.message).not.toContain("secret-value")
    }),
  )

  it.effect("fails on a known event whose shape does not match", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(reduceGithubDelivery("issues", '{"action":"opened"}', DELIVERY))
      expect(failure).toMatchObject({ event: "issues" })
    }),
  )

  it.effect("rejects a repository name with characters outside GitHub's set", () =>
    Effect.gen(function* () {
      const body = JSON.stringify({
        ref: "refs/heads/main",
        repository: { full_name: "a/b;rm" },
        sender: { login: "x" },
      })
      yield* Effect.flip(reduceGithubDelivery("push", body, DELIVERY))
    }),
  )

  it.effect("redacts token-shaped text in a title and cuts it to 200 characters", () =>
    Effect.gen(function* () {
      const body = JSON.parse(fixture("issues.json")) as { issue: { title: string } }
      const token = ["gh", "p_", "abcdefghijklmnop1234"].join("")
      body.issue.title = `leak ${token} ${"x".repeat(400)}`
      const reduced = yield* reduceGithubDelivery("issues", JSON.stringify(body), DELIVERY)
      expect(reduced._tag).toBe("event")
      if (reduced._tag !== "event") return
      const title = reduced.event.payload.title
      expect(typeof title).toBe("string")
      expect(String(title)).not.toContain(token)
      expect(String(title)).toContain("[redacted]")
      expect(String(title).length).toBeLessThanOrEqual(200)
    }),
  )

  it.effect("answers a hostile 200 KB title with a title cut to 200 characters", () =>
    Effect.gen(function* () {
      const body = JSON.parse(fixture("issues.json")) as { issue: { title: string } }
      body.issue.title = "1".repeat(200_000)
      const reduced = yield* reduceGithubDelivery("issues", JSON.stringify(body), DELIVERY)
      expect(reduced._tag).toBe("event")
      if (reduced._tag !== "event") return
      expect(String(reduced.event.payload.title).length).toBeLessThanOrEqual(200)
    }),
  )
})

describe("text and branch helpers", () => {
  it("cleanText redacts Telegram-shaped tokens and cuts to the limit", () => {
    expect(cleanText("12345678:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh", 100)).toBe("[redacted]")
    expect(cleanText("abcdef", 3)).toBe("abc")
  })

  it("isBotBranch matches the Tank's bot/<bot>/step_ branches only", () => {
    expect(isBotBranch("bot/dev-demo/step_00000000-0000-4000-8000-000000000002")).toBe(true)
    expect(isBotBranch("feature/bot/x")).toBe(false)
    expect(isBotBranch("main")).toBe(false)
    expect(isBotBranch(undefined)).toBe(false)
  })
})

describe("own work and third-party text", () => {
  it.effect("a PR from a fork that uses a Bot branch name is not the Bot's own work", () =>
    Effect.gen(function* () {
      const body = JSON.parse(fixture("pull_request.json")) as {
        pull_request: { head: { repo: { full_name: string } } }
      }
      body.pull_request.head.repo.full_name = "someone/fork"
      const reduced = yield* reduceGithubDelivery("pull_request", JSON.stringify(body), DELIVERY)
      expect(reduced).toMatchObject({ _tag: "event", event: { payload: { botAuthored: false } } })
    }),
  )

  it.effect("a PR whose head repository is gone (null) is not the Bot's own work", () =>
    Effect.gen(function* () {
      const body = JSON.parse(fixture("pull_request.json")) as { pull_request: { head: { repo: unknown } } }
      body.pull_request.head.repo = null
      const reduced = yield* reduceGithubDelivery("pull_request", JSON.stringify(body), DELIVERY)
      expect(reduced).toMatchObject({ _tag: "event", event: { payload: { botAuthored: false } } })
    }),
  )

  it.effect("a check suite from another repository is not the Bot's own work", () =>
    Effect.gen(function* () {
      const body = JSON.parse(fixture("check_suite.json")) as {
        check_suite: { head_repository: { full_name: string } }
      }
      body.check_suite.head_repository.full_name = "someone/fork"
      const reduced = yield* reduceGithubDelivery("check_suite", JSON.stringify(body), DELIVERY)
      expect(reduced).toMatchObject({ _tag: "event", event: { payload: { botAuthored: false } } })
    }),
  )

  it.effect("sender, action and title lose controls, line breaks and bidi overrides", () =>
    Effect.gen(function* () {
      const body = JSON.parse(fixture("issues.json")) as {
        action: string
        issue: { title: string }
        sender: { login: string }
      }
      body.action = "opened\u202e\nevil"
      body.issue.title = "line one\nline two\u2066hidden\u2069"
      body.sender.login = "renzer83\u202e"
      const reduced = yield* reduceGithubDelivery("issues", JSON.stringify(body), DELIVERY)
      expect(reduced).toMatchObject({
        _tag: "event",
        event: {
          actor: "github:renzer83",
          payload: { action: "opened evil", title: "line one line two hidden", sender: "renzer83" },
        },
      })
    }),
  )

  it.effect("a URL that is not plain https without credentials falls back to the repository", () =>
    Effect.gen(function* () {
      const body = JSON.parse(fixture("issues.json")) as { issue: { html_url: string } }
      body.issue.html_url = "http://evil.example/x"
      const reduced = yield* reduceGithubDelivery("issues", JSON.stringify(body), DELIVERY)
      expect(reduced).toMatchObject({
        _tag: "event",
        event: { payload: { url: "https://github.com/renzer83/shoalwork-sandbox" } },
      })
    }),
  )
})

describe("httpsUrl", () => {
  it("keeps https URLs and rejects http, credentials and non-URLs", () => {
    const fallback = "https://github.com/a/b"
    expect(httpsUrl("https://github.com/a/b/pull/1", fallback)).toBe("https://github.com/a/b/pull/1")
    expect(httpsUrl("http://github.com/a", fallback)).toBe(fallback)
    expect(httpsUrl("https://user:pw@github.com/a", fallback)).toBe(fallback)
    expect(httpsUrl("not a url", fallback)).toBe(fallback)
    expect(httpsUrl(undefined, fallback)).toBe(fallback)
  })
})
