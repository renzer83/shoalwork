import { it } from "@effect/vitest"
import { Beacon, BeaconTest } from "@shoalwork/beacon"
import type { EventType, NewEvent } from "@shoalwork/contracts"
import { withTempDb } from "@shoalwork/db/testing"
import { Effect, Layer } from "effect"
import { describe, expect, test } from "vitest"
import { Kanban } from "../src/kanban.js"
import { KanbanLive } from "../src/kanban-live.js"
import { decideDelivery, type GithubDelivery, issueNumberOf, repoOf } from "../src/sync-github.js"

const TestLayer = Layer.provideMerge(KanbanLive, Layer.provideMerge(BeaconTest, withTempDb()))

const REPO = "https://github.com/x/faturium"

const base = (deliveryId: string) => ({
  deliveryId,
  repo: "x/faturium",
  action: "opened",
  sender: "github:alice",
  url: REPO,
  botAuthored: false,
})

const githubEvent = (type: EventType, payload: Record<string, unknown>): NewEvent => ({
  streamId: "project:faturium",
  type,
  payload,
  actor: "github:alice",
  correlationId: "corr_sync",
})

describe("issueNumberOf", () => {
  test("finds the issue a PR title closes", () => {
    expect(issueNumberOf("Closes #12")).toBe(12)
    expect(issueNumberOf("fix: fixes #7 and updates docs")).toBe(7)
    expect(issueNumberOf("no issue here")).toBeUndefined()
    expect(issueNumberOf("")).toBeUndefined()
  })
})

describe("repoOf", () => {
  test("extracts owner/name from a repo url", () => {
    expect(repoOf("https://github.com/x/faturium")).toBe("x/faturium")
    expect(repoOf("https://github.com/x/faturium/")).toBe("x/faturium")
    expect(repoOf("https://github.com/x/faturium.git")).toBe("x/faturium")
    expect(repoOf("git@github.com:x/faturium.git")).toBe("x/faturium")
    expect(repoOf("git@github.com:x/faturium")).toBe("x/faturium")
  })
})

describe("decideDelivery", () => {
  test("maps the three GitHub event kinds to decisions", () => {
    const issue: GithubDelivery = {
      type: "github.issues",
      deliveryId: "d1",
      repo: "x/f",
      action: "opened",
      number: 1,
      title: "add sum",
      labels: ["ready"],
    }
    expect(decideDelivery(issue)).toEqual({ _tag: "create", issueNumber: 1, title: "add sum", to: "ready" })

    const labeledIssue: GithubDelivery = {
      type: "github.issues",
      deliveryId: "d1_labeled",
      repo: "x/f",
      action: "labeled",
      number: 1,
      title: "add sum",
      labels: ["ready"],
    }
    expect(decideDelivery(labeledIssue)).toEqual({
      _tag: "create",
      issueNumber: 1,
      title: "add sum",
      to: "ready",
    })

    const reopenedIssue: GithubDelivery = {
      type: "github.issues",
      deliveryId: "d1_reopened",
      repo: "x/f",
      action: "reopened",
      number: 1,
      title: "add sum",
      labels: ["ready"],
    }
    expect(decideDelivery(reopenedIssue)).toEqual({
      _tag: "create",
      issueNumber: 1,
      title: "add sum",
      to: "ready",
    })

    const pr: GithubDelivery = {
      type: "github.pull_request",
      deliveryId: "d2",
      repo: "x/f",
      action: "opened",
      number: 10,
      title: "Closes #1",
      headBranch: "feat/x",
    }
    expect(decideDelivery(pr)).toEqual({ _tag: "review", issueNumber: 1, prNumber: 10, branch: "feat/x" })

    const ci: GithubDelivery = {
      type: "github.workflow_run",
      deliveryId: "d3",
      repo: "x/f",
      action: "completed",
      conclusion: "success",
      headBranch: "feat/x",
    }
    expect(decideDelivery(ci)).toEqual({ _tag: "testing", branch: "feat/x" })
  })
})

describe("sync", () => {
  it.effect("applies the issue, PR and CI fixtures to one task", () =>
    Effect.gen(function* () {
      const kanban = yield* Kanban
      const beacon = yield* Beacon
      yield* kanban.addProject({
        slug: "faturium",
        name: "Faturium",
        repoUrl: REPO,
        defaultBranch: "main",
      })
      yield* beacon.append(
        githubEvent("github.issues", { ...base("d1"), number: 1, title: "add sum", labels: ["ready"] }),
      )
      yield* beacon.append(
        githubEvent("github.pull_request", {
          ...base("d2"),
          action: "opened",
          number: 10,
          title: "Closes #1",
          headBranch: "feat/x",
        }),
      )
      yield* beacon.append(
        githubEvent("github.workflow_run", {
          ...base("d3"),
          action: "completed",
          conclusion: "success",
          headBranch: "feat/x",
        }),
      )

      const report = yield* kanban.sync("faturium")
      expect(report).toEqual({ project: "faturium", applied: 3, skipped: 0 })

      const tasks = yield* kanban.listTasks("faturium")
      expect(tasks).toHaveLength(1)
      expect(tasks[0]).toMatchObject({ issueNumber: 1, prNumber: 10, state: "testing", branch: "feat/x" })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("is idempotent by delivery id", () =>
    Effect.gen(function* () {
      const kanban = yield* Kanban
      const beacon = yield* Beacon
      yield* kanban.addProject({
        slug: "faturium",
        name: "Faturium",
        repoUrl: REPO,
        defaultBranch: "main",
      })
      const issue = { ...base("d1"), number: 1, title: "add sum", labels: ["ready"] }
      yield* beacon.append(githubEvent("github.issues", issue))
      yield* beacon.append(githubEvent("github.issues", issue))

      const report = yield* kanban.sync("faturium")
      expect(report).toEqual({ project: "faturium", applied: 1, skipped: 1 })
      expect(yield* kanban.listTasks("faturium")).toHaveLength(1)
    }).pipe(Effect.provide(TestLayer)),
  )
})
