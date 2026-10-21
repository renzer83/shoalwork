import { it } from "@effect/vitest"
import { withTempDb } from "@shoalwork/db/testing"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import {
  type InstallationChange,
  installationEventPayload,
  isInstallationEvent,
  parseInstallation,
  recordInstallation,
} from "../../src/github/installations.js"
import { GithubPayloadError } from "../../src/github/webhook.js"

const installation = { id: 42, account: { login: "renzer83" } }
const repo = (full_name: string) => ({ full_name })

const created = JSON.stringify({
  action: "created",
  installation,
  repositories: [repo("renzer83/shoalwork-sandbox"), repo("renzer83/other")],
})
const deleted = JSON.stringify({ action: "deleted", installation })
const reposAdded = (names: ReadonlyArray<string>) =>
  JSON.stringify({ action: "added", installation, repositories_added: names.map(repo) })
const reposRemoved = (names: ReadonlyArray<string>) =>
  JSON.stringify({ action: "removed", installation, repositories_removed: names.map(repo) })

const StoredRow = Schema.Struct({ installation_id: Schema.Int, account: Schema.String, repos: Schema.String })
const storedRows = (sql: SqlClient) =>
  sql<{ readonly installation_id: number; readonly account: string; readonly repos: string }>`
    SELECT installation_id, account, repos FROM github_installations ORDER BY installation_id`.pipe(
    Effect.orDie,
    Effect.flatMap((rows) => Schema.decodeUnknownEffect(Schema.Array(StoredRow))(rows).pipe(Effect.orDie)),
  )

const write = (sql: SqlClient, change: InstallationChange) =>
  recordInstallation(sql, change).pipe(Effect.orDie)

describe("installation deliveries", () => {
  it("only installation and installation_repositories are installation events", () => {
    expect(isInstallationEvent("installation")).toBe(true)
    expect(isInstallationEvent("installation_repositories")).toBe(true)
    expect(isInstallationEvent("issues")).toBe(false)
    expect(isInstallationEvent(undefined)).toBe(false)
  })

  it.effect("parses created into a write that replaces the repos, and deleted into a delete", () =>
    Effect.gen(function* () {
      expect(yield* parseInstallation("installation", created)).toEqual({
        _tag: "write",
        installationId: 42,
        account: "renzer83",
        action: "created",
        set: ["renzer83/shoalwork-sandbox", "renzer83/other"],
        add: [],
        remove: [],
      })
      expect(yield* parseInstallation("installation", deleted)).toEqual({
        _tag: "delete",
        installationId: 42,
        account: "renzer83",
        action: "deleted",
      })
    }),
  )

  it.effect("parses installation_repositories into adds and removes on the stored list", () =>
    Effect.gen(function* () {
      expect(
        yield* parseInstallation("installation_repositories", reposAdded(["renzer83/new"])),
      ).toMatchObject({
        _tag: "write",
        set: undefined,
        add: ["renzer83/new"],
        remove: [],
      })
      expect(
        yield* parseInstallation("installation_repositories", reposRemoved(["renzer83/other"])),
      ).toMatchObject({
        _tag: "write",
        set: undefined,
        add: [],
        remove: ["renzer83/other"],
      })
    }),
  )

  it.effect("an action this table does not track is ignored, not an error", () =>
    Effect.gen(function* () {
      const body = JSON.stringify({ action: "new_permissions_accepted", installation })
      const parsed = yield* parseInstallation("installation", body)
      expect(parsed._tag).toBe("write")
      expect(
        yield* parseInstallation("installation", JSON.stringify({ action: "archived", installation })),
      ).toEqual({
        _tag: "ignored",
        name: "installation.archived",
      })
    }),
  )

  it.effect("a body that does not match its shape fails with GithubPayloadError", () =>
    Effect.gen(function* () {
      const bad = JSON.stringify({
        action: "created",
        installation,
        repositories: [repo("not a repo name!")],
      })
      const failure = yield* Effect.flip(parseInstallation("installation", bad))
      expect(failure).toBeInstanceOf(GithubPayloadError)
      expect(yield* Effect.flip(parseInstallation("installation", "not json"))).toBeInstanceOf(
        GithubPayloadError,
      )
    }),
  )

  it.layer(withTempDb())("the table follows the deliveries", (it) => {
    it.effect("created writes the row, added and removed patch its repos, deleted removes it", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient
        yield* write(sql, yield* parseInstallation("installation", created))
        expect(yield* storedRows(sql)).toEqual([
          {
            installation_id: 42,
            account: "renzer83",
            repos: '["renzer83/other","renzer83/shoalwork-sandbox"]',
          },
        ])

        yield* write(sql, yield* parseInstallation("installation_repositories", reposAdded(["renzer83/new"])))
        yield* write(
          sql,
          yield* parseInstallation("installation_repositories", reposRemoved(["RENZER83/OTHER"])),
        )
        expect(yield* storedRows(sql)).toEqual([
          {
            installation_id: 42,
            account: "renzer83",
            repos: '["renzer83/new","renzer83/shoalwork-sandbox"]',
          },
        ])

        yield* write(sql, yield* parseInstallation("installation", deleted))
        expect(yield* storedRows(sql)).toEqual([])
      }),
    )

    it.effect("a repos patch for an installation the table has not seen creates its row", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient
        yield* sql`DELETE FROM github_installations`.pipe(Effect.orDie)
        yield* write(
          sql,
          yield* parseInstallation("installation_repositories", reposAdded(["renzer83/late"])),
        )
        expect(yield* storedRows(sql)).toEqual([
          { installation_id: 42, account: "renzer83", repos: '["renzer83/late"]' },
        ])
      }),
    )
  })
})

describe("github.installation payload", () => {
  it("carries ids, account, action and repo names, never a token", () => {
    expect(
      installationEventPayload(
        { _tag: "delete", installationId: 42, account: "renzer83", action: "deleted" },
        "d-1",
      ),
    ).toEqual({ deliveryId: "d-1", installationId: 42, account: "renzer83", action: "deleted" })
    expect(
      installationEventPayload(
        {
          _tag: "write",
          installationId: 42,
          account: "renzer83",
          action: "added",
          set: undefined,
          add: ["a/b"],
          remove: [],
        },
        "d-2",
      ),
    ).toEqual({
      deliveryId: "d-2",
      installationId: 42,
      account: "renzer83",
      action: "added",
      added: ["a/b"],
      removed: [],
    })
    expect(
      installationEventPayload(
        {
          _tag: "write",
          installationId: 42,
          account: "renzer83",
          action: "created",
          set: ["a/b"],
          add: [],
          remove: [],
        },
        "d-3",
      ),
    ).toEqual({
      deliveryId: "d-3",
      installationId: 42,
      account: "renzer83",
      action: "created",
      repos: ["a/b"],
    })
  })
})
