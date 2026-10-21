import { it } from "@effect/vitest"
import { BotId, type TankError } from "@shoalwork/contracts"
import { Tank, type TankContext, type TankShape } from "@shoalwork/tank"
import { Effect, Schema } from "effect"
import { describe, expect } from "vitest"
import { OLLAMA_BASE_URL, opencodeConfigFor, writeOpencodeConfig } from "../../src/opencode/config.js"

const ctx: TankContext = {
  botId: Schema.decodeUnknownSync(BotId)("bot_00000000-0000-4000-8000-000000000001"),
  botName: "bot-a",
  cwd: "/tank/bot-a/work/step-1",
  home: "/tank/bot-a/home",
  env: { HOME: "/tank/bot-a/home" },
}

const parse = (text: string): Record<string, unknown> =>
  Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(JSON.parse(text))

describe("opencode config", () => {
  it("writes the schema URL and an Ollama provider on the OpenAI-compatible endpoint", () => {
    const config = parse(opencodeConfigFor(["ollama"]))
    expect(config.$schema).toBe("https://opencode.ai/config.json")
    expect(config.provider).toEqual({
      ollama: {
        npm: "@ai-sdk/openai-compatible",
        name: "Ollama",
        options: { baseURL: OLLAMA_BASE_URL },
      },
    })
    expect(OLLAMA_BASE_URL).toBe("http://localhost:11434/v1")
  })

  it("writes no provider entry for the built-in zai-coding-plan provider", () => {
    expect(parse(opencodeConfigFor(["zai-coding-plan"]))).toEqual({
      $schema: "https://opencode.ai/config.json",
    })
  })

  it("writes readonly as edit and bash denied, and no permission key otherwise", () => {
    expect(parse(opencodeConfigFor([], { edit: "deny", bash: "deny" })).permission).toEqual({
      edit: "deny",
      bash: "deny",
    })
    expect(parse(opencodeConfigFor([])).permission).toBeUndefined()
  })

  it("never writes a key, token or secret into the file", () => {
    const text = opencodeConfigFor(["ollama", "zai-coding-plan"], { edit: "deny", bash: "deny" })
    expect(text).not.toMatch(/apiKey|api_key|token|secret|password|sk-|ZHIPU/i)
  })

  it.effect("writes opencode.json in the run's cwd through the Tank", () =>
    Effect.gen(function* () {
      const writes: Array<{ readonly rel: string; readonly content: string; readonly cwd: string }> = []
      const unused = () => Effect.die("tank not used by the config writer")
      const shape: TankShape = {
        mode: "local",
        prepare: unused,
        exec: unused,
        spawnStream: unused,
        readFile: unused,
        writeFile: (writeCtx, rel, content): Effect.Effect<void, TankError> =>
          Effect.sync(() => {
            writes.push({ rel, content, cwd: writeCtx.cwd })
          }),
        writeHomeFile: unused,
        worktrees: unused,
        removeWorktree: unused,
        release: unused,
      }
      yield* writeOpencodeConfig(ctx, ["ollama"], { edit: "deny", bash: "deny" }).pipe(
        Effect.provideService(Tank, shape),
      )
      expect(writes).toHaveLength(1)
      expect(writes[0]?.rel).toBe("opencode.json")
      expect(writes[0]?.cwd).toBe(ctx.cwd)
      expect(parse(writes[0]?.content ?? "{}").permission).toEqual({ edit: "deny", bash: "deny" })
    }),
  )
})
