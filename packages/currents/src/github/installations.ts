import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import { cleanText, GithubPayloadError } from "./webhook.js"

// Installation deliveries keep the github_installations table in step with the App (T-084).
export const INSTALLATION_EVENTS: ReadonlySet<string> = new Set(["installation", "installation_repositories"])
export const isInstallationEvent = (event: string | undefined): boolean =>
  event !== undefined && INSTALLATION_EVENTS.has(event)

const REPO_NAME = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/
const RepoIn = Schema.Struct({ full_name: Schema.String.check(Schema.isPattern(REPO_NAME)) })
const InstallationIn = Schema.Struct({
  id: Schema.Int,
  account: Schema.Struct({ login: Schema.String }),
})
const InstallationEventIn = Schema.Struct({
  action: Schema.String,
  installation: InstallationIn,
  repositories: Schema.optional(Schema.Array(RepoIn)),
})
const InstallationReposIn = Schema.Struct({
  action: Schema.String,
  installation: InstallationIn,
  repositories_added: Schema.optional(Schema.Array(RepoIn)),
  repositories_removed: Schema.optional(Schema.Array(RepoIn)),
})
const RepoList = Schema.Array(Schema.String)
const decodeRepoList = Schema.decodeUnknownEffect(Schema.fromJsonString(RepoList))

// What one delivery does to a row. `set` replaces the repos; without it `add`/`remove` patch the stored list.
export type InstallationChange =
  | {
      readonly _tag: "delete"
      readonly installationId: number
      readonly account: string
      readonly action: string
    }
  | {
      readonly _tag: "write"
      readonly installationId: number
      readonly account: string
      readonly action: string
      readonly set: ReadonlyArray<string> | undefined
      readonly add: ReadonlyArray<string>
      readonly remove: ReadonlyArray<string>
    }
  | { readonly _tag: "ignored"; readonly name: string }

const fail = (event: string) => () =>
  new GithubPayloadError({ event, message: "payload does not match the expected GitHub shape" })

const namesOf = (repos: ReadonlyArray<{ readonly full_name: string }> | undefined): ReadonlyArray<string> =>
  (repos ?? []).map((repo) => repo.full_name)

// Pure: the change a delivery asks for. Unknown actions are ignored, not errors; malformed bodies fail.
export const parseInstallation = (
  event: string,
  rawBody: string,
): Effect.Effect<InstallationChange, GithubPayloadError> =>
  Effect.gen(function* () {
    const value = yield* Effect.try({ try: (): unknown => JSON.parse(rawBody), catch: fail(event) })
    if (event === "installation_repositories") {
      const body = yield* Schema.decodeUnknownEffect(InstallationReposIn)(value).pipe(
        Effect.mapError(fail(event)),
      )
      return {
        _tag: "write" as const,
        installationId: body.installation.id,
        account: cleanText(body.installation.account.login, 64),
        action: cleanText(body.action, 40),
        set: undefined,
        add: namesOf(body.repositories_added),
        remove: namesOf(body.repositories_removed),
      }
    }
    const body = yield* Schema.decodeUnknownEffect(InstallationEventIn)(value).pipe(
      Effect.mapError(fail(event)),
    )
    const installationId = body.installation.id
    const account = cleanText(body.installation.account.login, 64)
    const action = cleanText(body.action, 40)
    switch (body.action) {
      case "created":
        return {
          _tag: "write" as const,
          installationId,
          account,
          action,
          set: namesOf(body.repositories),
          add: [],
          remove: [],
        }
      case "unsuspend":
      case "new_permissions_accepted":
        return {
          _tag: "write" as const,
          installationId,
          account,
          action,
          set: body.repositories === undefined ? undefined : namesOf(body.repositories),
          add: [],
          remove: [],
        }
      case "deleted":
      case "suspend":
        return { _tag: "delete" as const, installationId, account, action }
      default:
        return { _tag: "ignored" as const, name: `${event}.${action}` }
    }
  })

// Payload of the github.installation event for a change (no token, no key). Optional keys are left out, not undefined.
export const installationEventPayload = (
  change: Exclude<InstallationChange, { readonly _tag: "ignored" }>,
  deliveryId: string,
): Record<string, unknown> => {
  const base = {
    deliveryId,
    installationId: change.installationId,
    account: change.account,
    action: change.action,
  }
  if (change._tag === "delete") return base
  return change.set === undefined
    ? { ...base, added: [...change.add], removed: [...change.remove] }
    : { ...base, repos: [...change.set] }
}

// Applies one change. A row that is not there yet is created by a write; a delete of a missing row is a no-op.
export const recordInstallation = (
  sql: SqlClient,
  change: InstallationChange,
): Effect.Effect<void, SqlError> => {
  if (change._tag === "ignored") return Effect.void
  if (change._tag === "delete") {
    return sql`DELETE FROM github_installations WHERE installation_id = ${change.installationId}`.pipe(
      Effect.asVoid,
    )
  }
  return Effect.gen(function* () {
    const rows = yield* sql<{ readonly repos: string }>`SELECT repos FROM github_installations
      WHERE installation_id = ${change.installationId}`
    const stored = yield* decodeRepoList(rows[0]?.repos ?? "[]").pipe(
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
    )
    const removed = new Set(change.remove.map((name) => name.toLowerCase()))
    // Sorted and unique, so the stored list does not depend on the order GitHub sent it in.
    const next = [...new Set([...(change.set ?? stored), ...change.add])]
      .filter((name) => !removed.has(name.toLowerCase()))
      .sort()
    yield* sql`INSERT INTO github_installations (installation_id, account, repos)
      VALUES (${change.installationId}, ${change.account}, ${JSON.stringify(next)})
      ON CONFLICT(installation_id) DO UPDATE SET account = excluded.account, repos = excluded.repos`
  })
}
