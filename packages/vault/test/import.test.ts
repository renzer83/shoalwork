import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { formatImportReport, importSecrets, parseSecretsMap } from "../src/import.js"

describe("vault import", () => {
  it.effect("parseSecretsMap maps keys to scopes and skips comments and blanks", () =>
    Effect.gen(function* () {
      const map = yield* parseSecretsMap(
        "# keys -> scope\nTELEGRAM_BOT_TOKEN: global\n\nANTHROPIC_API_KEY: bot\n",
      )
      expect(map).toEqual({ TELEGRAM_BOT_TOKEN: "global", ANTHROPIC_API_KEY: "bot" })
    }),
  )

  it.effect("parseSecretsMap rejects an unknown scope", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(parseSecretsMap("API_KEY: shared\n"))
      expect(error._tag).toBe("SecretMapError")
    }),
  )

  it("importSecrets maps mapped keys and reports unmapped ones without values", () => {
    const source = { API_KEY: "sk-live-secret-value-000", TOKEN: "abc-123-live", OTHER: "x" }
    const result = importSecrets(source, { API_KEY: "bot", OTHER: "global" })
    expect(result.mapped).toEqual([
      { key: "API_KEY", scope: "bot" },
      { key: "OTHER", scope: "global" },
    ])
    expect(result.unmapped).toEqual(["TOKEN"])
  })

  it("formatImportReport names keys and scopes but never the secret values", () => {
    const result = importSecrets({ API_KEY: "sk-live-secret-value-000" }, { API_KEY: "bot" })
    const report = formatImportReport(result)
    expect(report).toContain("API_KEY: bot")
    expect(report).not.toContain("sk-live-secret-value-000")
  })
})
