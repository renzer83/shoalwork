import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { PodClosedPayload, PodOpenedPayload } from "../src/events/pod.js"

const POD = "pod_7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a"
const TASK = "task_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
const BOT = "bot_3f2a9c1e-7b4d-4e8a-9f10-2c6d5e8b7a41"

const opened = { podId: POD, taskId: TASK, threadId: 101, botIds: [BOT] }
const closed = {
  podId: POD,
  taskId: TASK,
  summary: "1 passo(s) auxiliar(es): 1 concluído(s), 0 falhou(aram).",
}

describe("pod events", () => {
  it("round-trips pod.opened and pod.closed payloads", () => {
    expect(Schema.encodeSync(PodOpenedPayload)(Schema.decodeUnknownSync(PodOpenedPayload)(opened))).toEqual(
      opened,
    )
    expect(Schema.encodeSync(PodClosedPayload)(Schema.decodeUnknownSync(PodClosedPayload)(closed))).toEqual(
      closed,
    )
  })

  it("accepts a closing summary of exactly 2000 characters and rejects 2001", () => {
    const at = { ...closed, summary: "x".repeat(2000) }
    expect(Schema.decodeUnknownSync(PodClosedPayload)(at).summary).toHaveLength(2000)
    expect(() =>
      Schema.decodeUnknownSync(PodClosedPayload)({ ...closed, summary: "x".repeat(2001) }),
    ).toThrow()
  })

  it("rejects a pod.opened whose podId is not a pod id", () => {
    expect(() => Schema.decodeUnknownSync(PodOpenedPayload)({ ...opened, podId: TASK })).toThrow()
  })

  it("rejects a pod.opened whose threadId is not an integer", () => {
    expect(() => Schema.decodeUnknownSync(PodOpenedPayload)({ ...opened, threadId: 1.5 })).toThrow()
  })
})
