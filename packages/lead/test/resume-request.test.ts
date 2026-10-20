import { type BotId, newBotId, newTaskId, type TaskSpec, type TaskState } from "@shoalwork/contracts"
import { describe, expect, it } from "vitest"
import { continuationOf, matchTasks, parseResumeRequest, planResume } from "../src/resume-request.js"
import type { TaskRecord } from "../src/tasks.js"

const recordOf = (botId: BotId, title: string, state: TaskState): TaskRecord => {
  const spec: TaskSpec = {
    id: newTaskId(),
    botId,
    title,
    prompt: `${title}, please`,
    kind: "code",
    acceptance: [],
    budget: { tokens: 1000, seconds: 60, usd: 1 },
    tier: "light",
    origin: "telegram",
  }
  return {
    spec,
    state,
    attempts: 1,
    createdAt: "2026-10-19T10:00:00.000Z",
    updatedAt: "2026-10-19T10:00:00.000Z",
  }
}

describe("parseResumeRequest", () => {
  it("reads a task id as an id request", () => {
    const id = newTaskId()
    expect(parseResumeRequest(`continua a task ${id}`)).toEqual({ kind: "id", id })
  })

  it("reads anything else after 'task' as a title, trimmed", () => {
    expect(parseResumeRequest("continue task Refactor parser")).toEqual({
      kind: "title",
      title: "Refactor parser",
    })
    expect(parseResumeRequest("Continua a task   Deploy do site  ")).toEqual({
      kind: "title",
      title: "Deploy do site",
    })
  })

  it("is not a continuation request without a task, or with other verbs", () => {
    expect(parseResumeRequest("continua a task")).toBeUndefined()
    expect(parseResumeRequest("continua a tarefa Deploy")).toBeUndefined()
    expect(parseResumeRequest("continuar a task Deploy")).toBeUndefined()
    expect(parseResumeRequest("qual é a task de ontem?")).toBeUndefined()
  })
})

describe("matchTasks", () => {
  const bot = newBotId()
  const deploy = recordOf(bot, "Deploy", "done")
  const site = recordOf(bot, "Deploy do site", "done")

  it("prefers the exact title over the titles that contain it", () => {
    expect(matchTasks([deploy, site], { kind: "title", title: "deploy" })).toEqual([deploy])
  })

  it("falls back to the titles that contain the words", () => {
    expect(matchTasks([deploy, site], { kind: "title", title: "site" })).toEqual([site])
  })

  it("returns every task with the same title, which makes the request ambiguous", () => {
    const twin = recordOf(bot, "Deploy", "failed")
    expect(matchTasks([deploy, twin, site], { kind: "title", title: "Deploy" })).toEqual([deploy, twin])
  })

  it("matches an id only", () => {
    expect(matchTasks([deploy, site], { kind: "id", id: site.spec.id })).toEqual([site])
    expect(matchTasks([deploy], { kind: "id", id: newTaskId() })).toEqual([])
  })
})

describe("planResume", () => {
  const bot = newBotId()

  it("nothing matched is None", () => {
    expect(planResume([])).toEqual({ _tag: "None" })
  })

  it("two or more matches are Ambiguous, with all of them", () => {
    const records = [recordOf(bot, "Deploy", "done"), recordOf(bot, "Deploy", "failed")]
    expect(planResume(records)).toEqual({ _tag: "Ambiguous", records })
  })

  it("a single task that has finished is Resume, one that is still going is Running", () => {
    const finished = recordOf(bot, "Deploy", "cancelled")
    const going = recordOf(bot, "Deploy", "running")
    expect(planResume([finished])).toEqual({ _tag: "Resume", record: finished })
    expect(planResume([going])).toEqual({ _tag: "Running", record: going })
  })
})

describe("continuations and title tips", () => {
  const bot = newBotId()

  it("a title names the newest task of a chain, not the parent it continues", () => {
    const parent = recordOf(bot, "Deploy", "failed")
    const child = {
      ...recordOf(bot, "Deploy", "done"),
      spec: { ...recordOf(bot, "Deploy", "done").spec, resumeOf: parent.spec.id },
    }
    expect(matchTasks([parent, child], { kind: "title", title: "Deploy" })).toEqual([child])
    expect(planResume(matchTasks([parent, child], { kind: "title", title: "deploy" }))).toEqual({
      _tag: "Resume",
      record: child,
    })
  })

  it("an id names its task whatever its place in a chain", () => {
    const parent = recordOf(bot, "Deploy", "failed")
    const child = {
      ...recordOf(bot, "Deploy", "done"),
      spec: { ...recordOf(bot, "Deploy", "done").spec, resumeOf: parent.spec.id },
    }
    expect(matchTasks([parent, child], { kind: "id", id: parent.spec.id })).toEqual([parent])
  })

  it("continuationOf finds the unfinished task that names the parent", () => {
    const parent = recordOf(bot, "Deploy", "failed")
    const running = {
      ...recordOf(bot, "Deploy again", "received"),
      spec: { ...recordOf(bot, "x", "received").spec, resumeOf: parent.spec.id },
    }
    const finished = {
      ...recordOf(bot, "Old", "done"),
      spec: { ...recordOf(bot, "x", "done").spec, resumeOf: parent.spec.id },
    }
    expect(continuationOf([parent, finished, running], parent.spec.id)).toEqual(running)
    expect(continuationOf([parent, finished, running], parent.spec.id, running.spec.id)).toBeUndefined()
    expect(continuationOf([parent, finished], parent.spec.id)).toBeUndefined()
  })

  it("a long title is cut before matching", () => {
    const request = parseResumeRequest(`continua a task ${"x".repeat(300)}`)
    expect(request?.kind === "title" ? request.title.length : 0).toBe(120)
  })
})
