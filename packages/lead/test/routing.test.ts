import type { ModelTier, TaskKind } from "@shoalwork/contracts"
import { TierRouting } from "@shoalwork/executors"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { tierFor } from "../src/routing.js"

// Same routing table as config/model-tiers.yaml.
const SHIPPED: TierRouting = Schema.decodeUnknownSync(TierRouting)({
  code: "heavy",
  research: "heavy",
  plan: "heavy",
  review: "heavy",
  chat: "chat",
  status: "chat",
  system: "chat",
  app_op: "light",
  routine: "light",
})

const KINDS: ReadonlyArray<TaskKind> = ["chat", "system", "code", "research", "app_op", "routine"]

describe("tierFor", () => {
  it("routes each task kind to the tier of the shipped table", () => {
    const expected: Record<TaskKind, ModelTier> = {
      chat: "chat",
      system: "chat",
      code: "heavy",
      research: "heavy",
      app_op: "light",
      routine: "light",
    }
    for (const kind of KINDS) {
      expect(tierFor(kind, SHIPPED)).toBe(expected[kind])
    }
  })

  it("answers for every task kind, so no kind falls outside the table", () => {
    for (const kind of KINDS) {
      expect(["chat", "decision", "light", "heavy"]).toContain(tierFor(kind, SHIPPED))
    }
  })

  it("follows the table, not the kind name: editing the yaml moves a kind to another tier", () => {
    const edited: TierRouting = { ...SHIPPED, app_op: "heavy", code: "light" }
    expect(tierFor("app_op", edited)).toBe("heavy")
    expect(tierFor("code", edited)).toBe("light")
    expect(tierFor("routine", edited)).toBe("light")
  })
})
