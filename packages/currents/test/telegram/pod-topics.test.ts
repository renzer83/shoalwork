import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { createPodTopic, podTopicName, postToTopic } from "../../src/telegram/topics.js"
import { FORUM_CHAT, makeFakeTelegram } from "../support.js"

describe("pod topics", () => {
  it("names the topic pod-<first six characters of the task id>", () => {
    expect(podTopicName("task_0f3c2a9e-1111-4222-8333-444455556666")).toBe("pod-0f3c2a")
  })

  it.effect("creates the forum topic in the forum chat and returns its thread", () =>
    Effect.gen(function* () {
      const fake = makeFakeTelegram()
      const topic = yield* createPodTopic(fake.api, FORUM_CHAT, "pod-0f3c2a")
      expect(fake.topicsCreated).toEqual([{ chatId: FORUM_CHAT, name: "pod-0f3c2a" }])
      expect(topic).toEqual({ chatId: FORUM_CHAT, threadId: expect.any(Number) })
    }),
  )

  it.effect("posts escaped text into the thread, split at the Telegram limit and in order", () =>
    Effect.gen(function* () {
      const fake = makeFakeTelegram()
      const topic = { chatId: FORUM_CHAT, threadId: 42 }
      yield* postToTopic(fake.api, topic, `<b>oi</b> ${"a".repeat(5000)}`)
      expect(fake.sent.length).toBeGreaterThan(1)
      expect(fake.sent.every((message) => message.other.message_thread_id === 42)).toBe(true)
      expect(fake.sent.every((message) => message.other.parse_mode === "HTML")).toBe(true)
      expect(fake.sent[0]?.text.startsWith("&lt;b&gt;oi&lt;/b&gt; ")).toBe(true)
    }),
  )
})
