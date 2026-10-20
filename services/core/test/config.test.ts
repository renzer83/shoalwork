import { resolve } from "node:path"
import { MAX_AGENT_MSGS_PER_TASK } from "@shoalwork/lead"
import { Config, ConfigProvider, Effect, Exit, Option, Redacted } from "effect"
import { describe, expect, it } from "vitest"
import { AppConfig, optionalSetting, REPO_ROOT, resolveDatabasePath, setting } from "../src/config.js"

describe("resolveDatabasePath", () => {
  it("anchors a relative path to the repo root, not the cwd", () => {
    expect(resolveDatabasePath("./data/shoalwork.db", "/repo")).toBe("/repo/data/shoalwork.db")
  })

  it("keeps an absolute path as it is", () => {
    expect(resolveDatabasePath("/var/tmp/t.db", "/repo")).toBe("/var/tmp/t.db")
  })

  it("defaults the root to the directory that holds the repo package.json", () => {
    expect(resolveDatabasePath("./data/shoalwork.db")).toBe(`${REPO_ROOT}data/shoalwork.db`)
  })
})

// Reads the whole AppConfig from an env record, the way the core reads process.env.
const parseEnv = (env: Record<string, string>) =>
  Effect.runSync(AppConfig.parse(ConfigProvider.fromEnvRecord({ API_TOKEN: "token-for-tests", ...env })))

const readSetting = <A>(env: Record<string, string>, config: Config.Config<A>): A =>
  Effect.runSync(config.parse(ConfigProvider.fromEnvRecord(env)))

describe("API_TOKEN is fail-closed", () => {
  const tryParse = (env: Record<string, string>) =>
    Effect.runSyncExit(AppConfig.parse(ConfigProvider.fromEnvRecord(env)))

  it("refuses to start when API_TOKEN is unset", () => {
    const exit = tryParse({})
    expect(Exit.isFailure(exit)).toBe(true)
    expect(String(exit)).toContain("API_TOKEN")
  })

  it("refuses to start when API_TOKEN is blank", () => {
    for (const value of ["", "   "]) {
      const exit = tryParse({ API_TOKEN: value })
      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(exit)).toContain("API_TOKEN")
    }
  })

  it("keeps a non-blank token as a redacted value", () => {
    const exit = tryParse({ API_TOKEN: "token-for-tests" })
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) expect(Redacted.value(exit.value.apiToken)).toBe("token-for-tests")
  })
})

describe("setting: unset and blank take the default", () => {
  it("TANK_ROOT set but empty resolves to the default under the repo root, not to the repo root itself", () => {
    expect(parseEnv({ TANK_ROOT: "" }).tankRoot).toBe(resolve(REPO_ROOT, "data/tank"))
    expect(parseEnv({ TANK_ROOT: "   " }).tankRoot).toBe(resolve(REPO_ROOT, "data/tank"))
    expect(parseEnv({}).tankRoot).toBe(resolve(REPO_ROOT, "data/tank"))
  })

  it("keeps a non-blank value as it is", () => {
    expect(parseEnv({ TANK_ROOT: "/var/tank" }).tankRoot).toBe("/var/tank")
  })

  it("a blank Int takes the default instead of failing the parse", () => {
    const config = parseEnv({ PORT: "", WATCHDOG_STALE_MINUTES: " ", BUDGET_BOT_WINDOW_HOURS: "" })
    expect(config.port).toBe(28900)
    expect(config.watchdogStaleMinutes).toBe(20)
    expect(config.budgetBotWindowHours).toBe(24)
  })

  it("PLAN_CONCURRENCY defaults to 3 when unset or blank, is parsed otherwise and never drops below 1", () => {
    expect(parseEnv({}).planConcurrency).toBe(3)
    expect(parseEnv({ PLAN_CONCURRENCY: " " }).planConcurrency).toBe(3)
    expect(parseEnv({ PLAN_CONCURRENCY: "5" }).planConcurrency).toBe(5)
    expect(parseEnv({ PLAN_CONCURRENCY: "0" }).planConcurrency).toBe(1)
  })

  it("a non-blank Int is parsed", () => {
    expect(parseEnv({ PORT: "3000" }).port).toBe(3000)
  })

  it("a blank log level takes the default, an unknown one is still rejected", () => {
    expect(parseEnv({ LOG_LEVEL: "" }).logLevel).toBe("info")
    expect(() => parseEnv({ LOG_LEVEL: "loud" })).toThrow()
    expect(parseEnv({ LOG_LEVEL: "debug" }).logLevel).toBe("debug")
  })

  it("blank URL and model settings take their defaults", () => {
    const config = parseEnv({ OLLAMA_URL: "", OLLAMA_EMBED_MODEL: "  ", CODEX_MODEL: "" })
    expect(config.ollamaUrl).toBe("http://127.0.0.1:11434")
    expect(config.ollamaEmbedModel).toBe("bge-m3")
    expect(config.codexModel).toBeUndefined()
  })

  it("a blank Telegram token is unset, a set one is kept", () => {
    expect(Option.isNone(parseEnv({ TELEGRAM_BOT_TOKEN: "" }).telegramBotToken)).toBe(true)
    expect(Option.isNone(parseEnv({}).telegramBotToken)).toBe(true)
    const set = parseEnv({ TELEGRAM_BOT_TOKEN: "123:abc" }).telegramBotToken
    expect(Option.isSome(set)).toBe(true)
  })

  it("a blank GitHub webhook secret is unset", () => {
    expect(parseEnv({ GITHUB_WEBHOOK_SECRET: "  " }).githubWebhookSecret).toBeUndefined()
    expect(parseEnv({ GITHUB_WEBHOOK_SECRET: "s3cret" }).githubWebhookSecret).toBeDefined()
  })

  it("the boolean-like TANK_SUDO is on only for the exact value 1", () => {
    expect(parseEnv({ TANK_SUDO: "" }).tankSudo).toBe(false)
    expect(parseEnv({ TANK_SUDO: "1" }).tankSudo).toBe(true)
  })

  it("the helper returns the fallback for blank values and the parsed value otherwise", () => {
    const port = setting("PORT_UNDER_TEST", Config.Int, 7)
    expect(readSetting({ PORT_UNDER_TEST: "" }, port)).toBe(7)
    expect(readSetting({}, port)).toBe(7)
    expect(readSetting({ PORT_UNDER_TEST: "9" }, port)).toBe(9)
    const token = optionalSetting("TOKEN_UNDER_TEST", Config.String)
    expect(Option.isNone(readSetting({ TOKEN_UNDER_TEST: "" }, token))).toBe(true)
    expect(readSetting({ TOKEN_UNDER_TEST: "x" }, token)).toEqual(Option.some("x"))
  })
})

describe("MAX_AGENT_MSGS_PER_TASK", () => {
  it("takes the Lead's default when unset or blank", () => {
    expect(parseEnv({}).maxAgentMsgsPerTask).toBe(MAX_AGENT_MSGS_PER_TASK)
    expect(parseEnv({ MAX_AGENT_MSGS_PER_TASK: "" }).maxAgentMsgsPerTask).toBe(MAX_AGENT_MSGS_PER_TASK)
    expect(parseEnv({ MAX_AGENT_MSGS_PER_TASK: "  " }).maxAgentMsgsPerTask).toBe(MAX_AGENT_MSGS_PER_TASK)
    expect(MAX_AGENT_MSGS_PER_TASK).toBe(20)
  })

  it("takes a whole number of at least 1", () => {
    expect(parseEnv({ MAX_AGENT_MSGS_PER_TASK: "5" }).maxAgentMsgsPerTask).toBe(5)
    expect(parseEnv({ MAX_AGENT_MSGS_PER_TASK: "1" }).maxAgentMsgsPerTask).toBe(1)
  })

  it("refuses zero, negative, fractional and non-numeric values", () => {
    for (const value of ["0", "-3", "1.5", "many"]) {
      expect(() => parseEnv({ MAX_AGENT_MSGS_PER_TASK: value })).toThrow()
    }
  })
})
