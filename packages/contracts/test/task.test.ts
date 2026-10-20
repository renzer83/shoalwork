import { readFileSync } from "node:fs"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Artifact, RepoRef, TaskSpec } from "../src/task.js"

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"))

const minimalTask = {
  id: "task_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  botId: "bot_3f2a9c1e-7b4d-4e8a-9f10-2c6d5e8b7a41",
  title: "Plain chat",
  prompt: "hello",
  kind: "chat",
  budget: { tokens: 1000, seconds: 60, usd: 0.01 },
  tier: "chat",
  origin: "telegram",
}

describe("task", () => {
  it("TaskSpec round-trips the fixture", () => {
    const raw = fixture("task.json")
    expect(Schema.encodeSync(TaskSpec)(Schema.decodeUnknownSync(TaskSpec)(raw))).toEqual(raw)
  })

  it("acceptance defaults to an empty array when the key is missing", () => {
    const decoded = Schema.decodeUnknownSync(TaskSpec)(minimalTask)
    expect(decoded.acceptance).toEqual([])
    expect(decoded.repo).toBeUndefined()
  })

  it("correlationId is optional and round-trips when present", () => {
    expect(Schema.decodeUnknownSync(TaskSpec)(minimalTask).correlationId).toBeUndefined()
    const raw = { ...minimalTask, acceptance: [], correlationId: "evt_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d" }
    expect(Schema.encodeSync(TaskSpec)(Schema.decodeUnknownSync(TaskSpec)(raw))).toEqual(raw)
    expect(() => Schema.decodeUnknownSync(TaskSpec)({ ...minimalTask, correlationId: 7 })).toThrow()
  })

  it("rejects a task kind outside the closed list", () => {
    expect(() => Schema.decodeUnknownSync(TaskSpec)({ ...minimalTask, kind: "deploy" })).toThrow()
  })

  it("rejects a task whose botId is a TaskId", () => {
    const raw = { ...minimalTask, botId: minimalTask.id }
    expect(() => Schema.decodeUnknownSync(TaskSpec)(raw)).toThrow()
  })

  it("RepoRef round-trips url and base branch", () => {
    const raw = { url: "https://github.com/renzer83/shoalwork", base: "main" }
    expect(Schema.encodeSync(RepoRef)(Schema.decodeUnknownSync(RepoRef)(raw))).toEqual(raw)
  })

  it("RepoRef round-trips with and without the issue the PR closes", () => {
    const withIssue = { url: "https://github.com/renzer83/shoalwork", base: "main", issue: 12 }
    expect(Schema.encodeSync(RepoRef)(Schema.decodeUnknownSync(RepoRef)(withIssue))).toEqual(withIssue)
    const withoutIssue = { url: "https://github.com/renzer83/shoalwork", base: "main" }
    const decoded = Schema.decodeUnknownSync(RepoRef)(withoutIssue)
    expect(decoded.issue).toBeUndefined()
    expect(Schema.encodeSync(RepoRef)(decoded)).toEqual(withoutIssue)
  })

  it("RepoRef rejects an issue that is not an integer", () => {
    expect(() =>
      Schema.decodeUnknownSync(RepoRef)({
        url: "https://github.com/renzer83/shoalwork",
        base: "main",
        issue: 1.5,
      }),
    ).toThrow()
  })

  it("Artifact round-trips with and without summary, and rejects unknown kind", () => {
    const withSummary = { kind: "pr", ref: "https://github.com/renzer83/shoalwork/pull/12", summary: "retry" }
    const withoutSummary = { kind: "text", ref: "notes" }
    expect(Schema.encodeSync(Artifact)(Schema.decodeUnknownSync(Artifact)(withSummary))).toEqual(withSummary)
    expect(Schema.encodeSync(Artifact)(Schema.decodeUnknownSync(Artifact)(withoutSummary))).toEqual(
      withoutSummary,
    )
    expect(() => Schema.decodeUnknownSync(Artifact)({ kind: "binary", ref: "x" })).toThrow()
  })
})
