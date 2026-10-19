import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  BotKind,
  BotState,
  MemoryScope,
  ModelTier,
  Risk,
  TankMode,
  TaskKind,
  TaskOrigin,
  TaskState,
  VerdictKind,
} from "../src/enums.js"

const expectLiterals = (
  schema: Schema.Literals<ReadonlyArray<string>>,
  values: ReadonlyArray<string>,
): void => {
  for (const value of values) {
    expect(Schema.decodeUnknownSync(schema)(value)).toBe(value)
  }
  expect(() => Schema.decodeUnknownSync(schema)("nope")).toThrow()
}

describe("enums", () => {
  it("Risk accepts its literals and rejects unknown values", () => {
    expectLiterals(Risk, ["read", "write_local", "external", "irreversible"])
  })

  it("ModelTier accepts its literals and rejects unknown values", () => {
    expectLiterals(ModelTier, ["chat", "decision", "light", "heavy"])
  })

  it("BotKind accepts its literals and rejects unknown values", () => {
    expectLiterals(BotKind, ["fixed", "auxiliary"])
  })

  it("BotState accepts its literals and rejects unknown values", () => {
    expectLiterals(BotState, [
      "idle",
      "thinking",
      "working",
      "waiting_approval",
      "blocked",
      "done",
      "paused",
      "archived",
    ])
  })

  it("TaskState accepts its literals and rejects unknown values", () => {
    expectLiterals(TaskState, [
      "received",
      "planning",
      "ready",
      "running",
      "waiting_approval",
      "verifying",
      "done",
      "failed",
      "cancelled",
    ])
  })

  it("TaskKind accepts its literals and rejects unknown values", () => {
    expectLiterals(TaskKind, ["chat", "system", "code", "research", "app_op", "routine"])
  })

  it("TaskOrigin accepts its literals and rejects unknown values", () => {
    expectLiterals(TaskOrigin, ["telegram", "api", "cli", "tide", "bot"])
  })

  it("VerdictKind accepts its literals and rejects unknown values", () => {
    expectLiterals(VerdictKind, ["ok", "failed", "needs_approval", "budget_exceeded", "blocked"])
  })

  it("TankMode accepts its literals and rejects unknown values", () => {
    expectLiterals(TankMode, ["local", "server"])
  })

  it("MemoryScope accepts its literals and rejects unknown values", () => {
    expectLiterals(MemoryScope, ["bot", "pod", "global"])
  })
})
