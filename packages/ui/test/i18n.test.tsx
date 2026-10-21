import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { en, type MessageKey } from "../src/i18n/en.js"
import { CODENAME_KEYS, CODENAMES, codenameOf, detectLocale, translate } from "../src/i18n/index.js"
import { ptBR } from "../src/i18n/pt-BR.js"

afterEach(() => {
  vi.unstubAllGlobals()
})

const keysOf = (table: Readonly<Record<string, string>>): Array<string> => Object.keys(table).sort()
const placeholdersOf = (text: string): Array<string> =>
  [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? "").sort()

describe("message tables", () => {
  it("pt-BR defines exactly the keys of en", () => {
    expect(keysOf(ptBR)).toEqual(keysOf(en))
  })

  it("every message is non-empty in both languages", () => {
    for (const key of Object.keys(en) as Array<MessageKey>) {
      expect(en[key].trim(), key).not.toBe("")
      expect(ptBR[key].trim(), key).not.toBe("")
    }
  })

  it("both languages use the same placeholders in every message", () => {
    for (const key of Object.keys(en) as Array<MessageKey>) {
      expect(placeholdersOf(ptBR[key]), key).toEqual(placeholdersOf(en[key]))
    }
  })
})

describe("translate", () => {
  it("fills the placeholders of the chosen language", () => {
    expect(translate("en", "common.httpAnswered", { status: 500 })).toBe("The core answered HTTP 500")
    expect(translate("pt-BR", "common.httpAnswered", { status: 500 })).toBe("O core respondeu HTTP 500")
  })

  it("keeps a placeholder that has no value", () => {
    expect(translate("en", "common.httpAnswered")).toBe("The core answered HTTP {status}")
  })
})

describe("detectLocale", () => {
  it("reads any Portuguese system language as pt-BR", () => {
    vi.stubGlobal("navigator", { language: "pt-BR" })
    expect(detectLocale()).toBe("pt-BR")
    vi.stubGlobal("navigator", { language: "pt-PT" })
    expect(detectLocale()).toBe("pt-BR")
  })

  it("falls back to English for any other system language", () => {
    vi.stubGlobal("navigator", { language: "fr-FR" })
    expect(detectLocale()).toBe("en")
  })
})

describe("codenames", () => {
  it("names every component in both sets", () => {
    expect(CODENAME_KEYS).toEqual([
      "lead",
      "bot",
      "pod",
      "reflex",
      "reef",
      "tank",
      "beacon",
      "current",
      "tide",
    ])
    for (const set of ["en", "pt"] as const) {
      for (const key of CODENAME_KEYS) {
        expect(CODENAMES[set][key].trim(), `${set}.${key}`).not.toBe("")
      }
    }
  })

  it("uses the English technical names by default and the Portuguese set on request", () => {
    expect(codenameOf("tank")).toBe("Tank")
    expect(codenameOf("tank", "en")).toBe("Tank")
    expect(codenameOf("tank", "pt")).toBe("Tanque")
    expect(codenameOf("lead", "pt")).toBe("Guia")
  })
})

// Text on screen comes from the message tables. A literal in JSX text or in a label attribute is a regression.
const SOURCE = resolve(process.cwd(), "src")
const tsxFilesUnder = (dir: string): Array<string> =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return tsxFilesUnder(path)
    return name.endsWith(".tsx") ? [path] : []
  })
const JSX_TEXT = /(?<![=-])>\s*[^<>{}\n]*[A-Za-zÀ-ú][^<>{}\n]*</
const LITERAL_LABEL =
  /\b(label|title|placeholder|accessibilityLabel|hint|subtitle|helperText|message)="[^"{]*[A-Za-zÀ-ú]/

describe("screens and components", () => {
  it("keep their visible text in the message tables, not as literals", () => {
    const offenders = ["screens", "components", "navigation"]
      .flatMap((dir) => tsxFilesUnder(join(SOURCE, dir)))
      .flatMap((file) =>
        readFileSync(file, "utf8")
          .split("\n")
          .map((line, index) => ({ line: line.trim(), index }))
          .filter(({ line }) => !line.startsWith("import") && !line.startsWith("//") && !line.startsWith("*"))
          .filter(({ line }) => JSX_TEXT.test(line) || LITERAL_LABEL.test(line))
          .map(({ line, index }) => `${file}:${index + 1}: ${line}`),
      )
    expect(offenders).toEqual([])
  })
})
