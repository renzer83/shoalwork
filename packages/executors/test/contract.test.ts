import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { it } from "@effect/vitest"
import type { Budget, ExecutorEvent } from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import { describe, expect } from "vitest"
import {
  ClaudeStreamLine,
  toExecutorEvents as claudeEvents,
  makeMapperState as claudeState,
} from "../src/claude-code/events.js"
import { CodexEvent, makeCodexMapper } from "../src/codex/events.js"
import {
  GeminiStreamLine,
  toExecutorEvents as geminiEvents,
  makeMapperState as geminiState,
} from "../src/gemini/events.js"
import { makeOpencodeMapper, OpencodeLine } from "../src/opencode/events.js"

// Every recorded CLI version under test/fixtures/<executor>/<version>/ must still parse with the current parser.
// Recording a new version and keeping this file green is the gate for bumping config/executor-versions.yaml.
const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url))
const EXECUTORS = ["claude-code", "codex", "gemini", "opencode"] as const
type Executor = (typeof EXECUTORS)[number]

const BUDGET: Budget = { tokens: 1_000_000, seconds: 3_600, usd: 10 }

const Manifest = Schema.Struct({
  version: Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/)),
  recordedAt: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}/)),
  command: Schema.String,
  note: Schema.optionalKey(Schema.String),
})

const versionsOf = (executor: Executor): ReadonlyArray<string> =>
  readdirSync(join(FIXTURES, executor), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

const linesOf = (text: string): ReadonlyArray<string> => text.split("\n").filter((line) => line.trim() !== "")

// Decodes each line with the parser's own schema, then maps it. A line the schema rejects fails the effect.
const replay: Record<
  Executor,
  (lines: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<ExecutorEvent>, unknown>
> = {
  "claude-code": (lines) =>
    Effect.gen(function* () {
      const state = claudeState("claude-code")
      const out: Array<ExecutorEvent> = []
      for (const line of lines) {
        const decoded = yield* Schema.decodeUnknownEffect(ClaudeStreamLine)(JSON.parse(line))
        out.push(...(yield* claudeEvents(decoded, state)))
      }
      return out
    }),
  codex: (lines) =>
    Effect.gen(function* () {
      const mapper = makeCodexMapper(BUDGET)
      const out: Array<ExecutorEvent> = []
      for (const line of lines) {
        const decoded = yield* Schema.decodeUnknownEffect(CodexEvent)(JSON.parse(line))
        out.push(...mapper.push(decoded))
      }
      return out
    }),
  gemini: (lines) =>
    Effect.gen(function* () {
      const state = geminiState(BUDGET)
      const out: Array<ExecutorEvent> = []
      for (const line of lines) {
        const decoded = yield* Schema.decodeUnknownEffect(GeminiStreamLine)(JSON.parse(line))
        out.push(...geminiEvents(state, decoded))
      }
      return out
    }),
  opencode: (lines) =>
    Effect.gen(function* () {
      const mapper = makeOpencodeMapper(BUDGET)
      const out: Array<ExecutorEvent> = []
      for (const line of lines) {
        const decoded = yield* Schema.decodeUnknownEffect(OpencodeLine)(JSON.parse(line))
        out.push(...(yield* mapper.push(decoded)))
      }
      out.push(...mapper.finish())
      return out
    }),
}

describe("executor fixture contract", () => {
  for (const executor of EXECUTORS) {
    describe(executor, () => {
      it("every version directory has a manifest naming that version", () => {
        for (const version of versionsOf(executor)) {
          const path = join(FIXTURES, executor, version, "manifest.json")
          const manifest = Schema.decodeUnknownSync(Manifest)(JSON.parse(readFileSync(path, "utf8")))
          expect(manifest.version).toBe(version)
        }
      })

      for (const version of versionsOf(executor)) {
        describe(`version ${version}`, () => {
          const dir = join(FIXTURES, executor, version)
          const names = readdirSync(dir)
            .filter((name) => name !== "manifest.json")
            .sort()

          for (const name of names) {
            it.effect(`${name} replays through the parser`, () =>
              Effect.gen(function* () {
                const text = readFileSync(join(dir, name), "utf8")
                if (name.endsWith(".json")) {
                  expect(typeof JSON.parse(text)).toBe("object")
                  return
                }
                const events = yield* replay[executor](linesOf(text))
                expect(events.length).toBeGreaterThan(0)
                if (name.startsWith("success")) expect(events.at(-1)?.kind).toBe("done")
              }),
            )
          }
        })
      }
    })
  }
})
