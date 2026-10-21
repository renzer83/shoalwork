import { it } from "@effect/vitest"
import { withTempDb } from "@shoalwork/db/testing"
import { Effect, Redacted } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import { GithubError, makeGithubApp } from "../../src/github/app.js"
import { fakeGitHub, MINUTE, PRIVATE_KEY, T0 } from "./app-support.js"

const config = (clock: { now: number }, fetch: typeof globalThis.fetch) => ({
  appId: "12345",
  privateKey: Redacted.make(PRIVATE_KEY),
  fetch,
  now: () => clock.now,
})

const seedInstallation = (sql: SqlClient, id: number, repos: string) =>
  sql`INSERT INTO github_installations (installation_id, account, repos) VALUES (${id}, 'renzer83', ${repos})
    ON CONFLICT(installation_id) DO UPDATE SET repos = excluded.repos`.pipe(Effect.orDie)

describe("installation tokens", () => {
  it.layer(withTempDb())("cache and renewal (fake clock)", (it) => {
    it.effect("reuses a token until five minutes before expiry, then mints a new one", () =>
      Effect.gen(function* () {
        const clock = { now: T0 }
        const gh = fakeGitHub(clock)
        const app = makeGithubApp(config(clock, gh.fetch), yield* SqlClient)
        expect(yield* app.tokenForInstallation(42)).toBe("ghs_1")
        clock.now = T0 + 54 * MINUTE
        expect(yield* app.tokenForInstallation(42)).toBe("ghs_1")
        expect(gh.mints()).toBe(1)
        clock.now = T0 + 56 * MINUTE
        expect(yield* app.tokenForInstallation(42)).toBe("ghs_2")
        expect(gh.mints()).toBe(2)
      }),
    )

    it.effect("concurrent callers for one installation share a single mint", () =>
      Effect.gen(function* () {
        const clock = { now: T0 }
        const gh = fakeGitHub(clock)
        const app = makeGithubApp(config(clock, gh.fetch), yield* SqlClient)
        const tokens = yield* Effect.all(
          [app.tokenForInstallation(42), app.tokenForInstallation(42), app.tokenForInstallation(42)],
          { concurrency: "unbounded" },
        )
        expect(tokens).toEqual(["ghs_1", "ghs_1", "ghs_1"])
        expect(gh.mints()).toBe(1)
      }),
    )

    it.effect("keeps one cache entry per installation", () =>
      Effect.gen(function* () {
        const clock = { now: T0 }
        const gh = fakeGitHub(clock)
        const app = makeGithubApp(config(clock, gh.fetch), yield* SqlClient)
        expect(yield* app.tokenForInstallation(42)).toBe("ghs_1")
        expect(yield* app.tokenForInstallation(43)).toBe("ghs_2")
        expect(yield* app.tokenForInstallation(42)).toBe("ghs_1")
        expect(gh.mints()).toBe(2)
      }),
    )

    it.effect("authenticates the token request with a bearer JWT for the App", () =>
      Effect.gen(function* () {
        const clock = { now: T0 }
        const gh = fakeGitHub(clock)
        const app = makeGithubApp(config(clock, gh.fetch), yield* SqlClient)
        yield* app.tokenForInstallation(42)
        const mint = gh.sent.find((sent) => sent.url.endsWith("/app/installations/42/access_tokens"))
        expect(mint?.method).toBe("POST")
        expect(mint?.authorization).toMatch(/^bearer .+\..+\..+$/)
      }),
    )
  })

  it.layer(withTempDb())("repo to installation lookup", (it) => {
    it.effect("finds the installation of a repo, case-insensitively, and its token", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient
        yield* seedInstallation(sql, 42, '["Renzer83/Shoalwork-Sandbox"]')
        const clock = { now: T0 }
        const gh = fakeGitHub(clock)
        const app = makeGithubApp(config(clock, gh.fetch), sql)
        expect(yield* app.installationIdFor("renzer83/shoalwork-sandbox")).toBe(42)
        expect(yield* app.tokenFor("renzer83/shoalwork-sandbox")).toBe("ghs_1")
      }),
    )

    it.effect("a repo no installation covers is a GithubError that names the repo", () =>
      Effect.gen(function* () {
        const clock = { now: T0 }
        const gh = fakeGitHub(clock)
        const app = makeGithubApp(config(clock, gh.fetch), yield* SqlClient)
        const failure = yield* Effect.flip(app.installationIdFor("someone/elsewhere"))
        expect(failure).toBeInstanceOf(GithubError)
        expect(failure.message).toBe("no installation covers someone/elsewhere")
        expect(gh.mints()).toBe(0)
      }),
    )
  })
})
