import { it } from "@effect/vitest"
import { BotRegistry } from "@shoalwork/bots"
import { newTaskId, type TaskSpec } from "@shoalwork/contracts"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { TaskStore } from "../src/index.js"
import { createBot, fakeExecutor, leadLayer, makeFakeTank, NEW_BOT, specFor } from "./support.js"

describe("TaskStore.listByBot", () => {
  it.effect("lists only the Bot's own tasks, newest first, at most the limit", () => {
    return Effect.gen(function* () {
      const store = yield* TaskStore
      const mine = yield* createBot
      const registry = yield* BotRegistry
      const theirs = yield* registry.upsert({ ...NEW_BOT, name: "other-bot" }, "test")
      const theirIds: Array<string> = []
      for (let i = 0; i < 2; i++) {
        const spec: TaskSpec = { ...specFor(theirs, { title: `theirs ${i}` }), id: newTaskId() }
        theirIds.push(spec.id)
        yield* store.insert(spec)
      }
      let last = ""
      for (let i = 0; i < 201; i++) {
        const spec: TaskSpec = { ...specFor(mine, { title: `mine ${i}` }), id: newTaskId() }
        last = spec.id
        yield* store.insert(spec)
      }

      const listedTheirs = yield* store.listByBot(theirs.id)
      expect(listedTheirs.map((record) => record.spec.id).sort()).toEqual([...theirIds].sort())
      expect(listedTheirs.every((record) => record.spec.botId === theirs.id)).toBe(true)

      const listedMine = yield* store.listByBot(mine.id)
      expect(listedMine).toHaveLength(200)
      expect(listedMine.every((record) => record.spec.botId === mine.id)).toBe(true)
      // Newest first: the last task inserted leads the list, the oldest one beyond the limit is not listed.
      expect(listedMine[0]?.spec.id).toBe(last)
    }).pipe(
      Effect.provide(
        leadLayer({
          executor: fakeExecutor(() => {
            throw new Error("not run")
          }),
          tank: makeFakeTank(),
        }),
      ),
    )
  })
})
