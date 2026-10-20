import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { decodeReflexConfigText } from "../src/config.js"
import {
  compileRules,
  complexityRule,
  executorRule,
  intentRule,
  languageRule,
  needsApprovalRule,
  ownerRule,
  parallelizableRule,
  riskRule,
  scoreAll,
} from "../src/rules.js"
import { CLAUDE, CODEX, config, DEV, factsFor, LEAD, WRITER } from "./support.js"

const rules = compileRules(config)

type Owner = "lead" | "dev" | "writer" | "new"

type Row = {
  readonly text: string
  readonly hasRepo?: boolean
  readonly intent: string
  readonly owner: Owner
  readonly risk: number
  readonly language: string
}

const OWNER_ID = { lead: LEAD, dev: DEV, writer: WRITER, new: "new" } as const
// Only bots with routing resolve an executor; the dev Bot has it, lead and writer do not.
const EXECUTOR_OF = { lead: "none", dev: CLAUDE, writer: "none", new: "none" } as const

// Expected answers for pt/en/es phrases: intent, owner, risk, language.
const TABLE: ReadonlyArray<Row> = [
  { text: "/status", intent: "system", owner: "lead", risk: 0, language: "other" },
  { text: "implementa o login para o app", intent: "code", owner: "dev", risk: 0, language: "pt" },
  { text: "fix the bug in the parser", intent: "code", owner: "dev", risk: 0, language: "en" },
  {
    text: "please refactor the auth module and add tests",
    intent: "code",
    owner: "dev",
    risk: 0,
    language: "en",
  },
  { text: "deploy to production now", intent: "code", owner: "dev", risk: 3, language: "other" },
  {
    text: "pesquisa o preço do ETH com a concorrência",
    intent: "research",
    owner: "lead",
    risk: 0,
    language: "pt",
  },
  { text: "compare the fees of two exchanges", intent: "research", owner: "lead", risk: 0, language: "en" },
  { text: "quanto custa uma VPS na Hetzner", intent: "research", owner: "lead", risk: 0, language: "other" },
  {
    text: "posta no twitter sobre o lançamento",
    intent: "app_op",
    owner: "lead",
    risk: 0,
    language: "other",
  },
  { text: "publish the release notes", intent: "app_op", owner: "lead", risk: 0, language: "en" },
  { text: "envia email para o cliente", intent: "app_op", owner: "lead", risk: 2, language: "pt" },
  { text: "stripe cobrança do mês", intent: "app_op", owner: "lead", risk: 3, language: "other" },
  { text: "todo dia às 9 manda o resumo", intent: "routine", owner: "lead", risk: 0, language: "other" },
  { text: "every day at 9 send the summary", intent: "routine", owner: "lead", risk: 0, language: "en" },
  { text: "me manda um oi", intent: "chat", owner: "lead", risk: 0, language: "other" },
  { text: "hi, how are you", intent: "chat", owner: "lead", risk: 0, language: "other" },
  { text: "delete the old branch", intent: "chat", owner: "lead", risk: 3, language: "en" },
  { text: "edit the readme with the new title", intent: "chat", owner: "lead", risk: 1, language: "en" },
  { text: "@dev-demo revisa isso", intent: "chat", owner: "dev", risk: 0, language: "other" },
  { text: "writer, escreve um post sobre IA", intent: "chat", owner: "writer", risk: 2, language: "other" },
  { text: "push the branch and then open a PR", intent: "code", owner: "dev", risk: 2, language: "en" },
  { text: "bom dia, tudo bem?", intent: "chat", owner: "lead", risk: 0, language: "other" },
  { text: "que horas são", intent: "chat", owner: "lead", risk: 0, language: "pt" },
  { text: "implement the feature with tests", intent: "code", owner: "dev", risk: 0, language: "en" },
  {
    text: "ajusta o parser do repo",
    hasRepo: true,
    intent: "code",
    owner: "dev",
    risk: 0,
    language: "other",
  },
  { text: "resume o texto com cuidado", intent: "chat", owner: "lead", risk: 0, language: "pt" },
  { text: "edit the config and then write docs", intent: "chat", owner: "lead", risk: 1, language: "en" },
  // Inflections added to the config tables.
  { text: "implementar o login e testar", intent: "code", owner: "dev", risk: 0, language: "other" },
  { text: "tests are failing, fix bugs", intent: "code", owner: "dev", risk: 0, language: "other" },
  { text: "revisar as PRs abertas", intent: "code", owner: "dev", risk: 0, language: "other" },
  { text: "pesquisar preços de VPS", intent: "research", owner: "lead", risk: 0, language: "other" },
  { text: "publicar o release", intent: "app_op", owner: "lead", risk: 0, language: "other" },
  { text: "deletar a branch antiga", intent: "chat", owner: "lead", risk: 3, language: "other" },
  { text: "remove the cache", intent: "chat", owner: "lead", risk: 3, language: "en" },
  { text: "pagamento pendente do cliente", intent: "chat", owner: "lead", risk: 3, language: "other" },
  // Spanish, including the pt/es tie (para is in both lists).
  { text: "el informe con los datos", intent: "chat", owner: "lead", risk: 0, language: "es" },
  { text: "la reunión es mañana", intent: "chat", owner: "lead", risk: 0, language: "es" },
  { text: "hola, ¿cómo estás?", intent: "chat", owner: "lead", risk: 0, language: "other" },
  { text: "para ti", intent: "chat", owner: "lead", risk: 0, language: "pt" },
]

describe("reflex rules table (pt/en/es)", () => {
  it("has at least 20 phrases", () => {
    expect(TABLE.length).toBeGreaterThanOrEqual(20)
  })

  for (const row of TABLE) {
    it(`answers ${JSON.stringify(row.text)} as intent=${row.intent} owner=${row.owner} risk=${row.risk} lang=${row.language}`, () => {
      const facts = factsFor(row.text, row.hasRepo === undefined ? {} : { hasRepo: row.hasRepo })
      const intent = intentRule(facts, rules)
      const owner = ownerRule(facts, rules, intent.value)
      const risk = riskRule(facts, rules)
      const language = languageRule(facts, rules)
      expect(intent.value).toBe(row.intent)
      expect(owner.value).toBe(OWNER_ID[row.owner])
      expect(risk.value).toBe(row.risk)
      expect(language.value).toBe(row.language)
      expect(needsApprovalRule(risk).value).toBe(row.risk >= 2)
      expect(executorRule(facts, owner.value).value).toBe(EXECUTOR_OF[row.owner])
    })
  }
})

describe("reflex rules: confidence and edge cases", () => {
  it("gives 0.9 to a whole-word code verb and 0.6 to repo presence alone", () => {
    expect(intentRule(factsFor("fix the bug"), rules).confidence).toBe(0.9)
    expect(intentRule(factsFor("ajusta o parser", { hasRepo: true }), rules)).toEqual({
      value: "code",
      confidence: 0.6,
    })
  })

  it("gives 0.5 to chat when no rule matches", () => {
    expect(intentRule(factsFor("bom dia"), rules)).toEqual({ value: "chat", confidence: 0.5 })
  })

  it("does not match a keyword inside a longer word", () => {
    expect(intentRule(factsFor("postado ontem"), rules).value).toBe("chat")
    expect(intentRule(factsFor("testamento"), rules).value).toBe("chat")
  })

  it("matches accented pt words as whole words", () => {
    expect(intentRule(factsFor("às 9 horas, por favor"), rules).value).toBe("routine")
    expect(intentRule(factsFor("pesquisa"), rules).value).toBe("research")
  })

  it("reads NFD text as its NFC form", () => {
    const nfd = "eu não sei"
    expect(nfd).not.toBe("eu não sei")
    expect(languageRule(factsFor(nfd), rules)).toEqual({ value: "pt", confidence: 0.6 })
  })

  it("ignores text beyond ruleChars", () => {
    const longText = `${"a ".repeat(4000)}delete`
    expect(longText.length).toBeGreaterThan(8000)
    expect(riskRule(factsFor(longText), rules).value).toBe(0)
  })

  it("evaluates a 200k-character whitespace input in linear time", () => {
    const hostile = "\n".repeat(100_000) + " ".repeat(100_000)
    const start = performance.now()
    scoreAll(factsFor(hostile), rules)
    expect(performance.now() - start).toBeLessThan(50)
  })

  it("gives owner from botHint over a mention and a code role", () => {
    const facts = factsFor("fix the bug, writer", { botHint: WRITER })
    expect(ownerRule(facts, rules, "code").value).toBe(WRITER)
  })

  it("gives the Bot mentioned first in the text, not the first in the bots list", () => {
    expect(ownerRule(factsFor("writer e depois @dev-demo revisa"), rules, "chat").value).toBe(WRITER)
    expect(ownerRule(factsFor("@dev-demo, writer revisa"), rules, "chat").value).toBe(DEV)
  })

  it("falls back to new when there is no lead and no candidate", () => {
    const facts = factsFor("bom dia", { bots: [{ id: WRITER, name: "writer", role: "content" }] })
    expect(ownerRule(facts, rules, "chat")).toEqual({ value: "new", confidence: 0.3 })
  })

  it("scores complexity from length, distinct verbs and sequence words", () => {
    expect(complexityRule(factsFor("oi"), rules).value).toBe(0)
    expect(complexityRule(factsFor("implementa login, testa e faz deploy"), rules).value).toBe(2)
    const long =
      "1. implementa o login com testes\n2. testa a API e depois faz deploy\n3. revisa o texto final com o time, depois publica o resumo no canal e acompanha as métricas da semana com calma e atenção"
    expect(complexityRule(factsFor(long), rules).value).toBe(4)
  })

  it("marks parallelizable only with complexity >= 3 and a list line", () => {
    const list =
      "1. implementa o login com testes\n2. testa a API e depois faz deploy\n3. revisa o texto final com o time, depois publica o resumo no canal e acompanha as métricas da semana com calma e atenção"
    const flat = `Plano: ${list.replace(/\n/g, " ")}`
    expect(parallelizableRule(factsFor(list), rules, 4).value).toBe(true)
    expect(parallelizableRule(factsFor(flat), rules, 4).value).toBe(false)
    expect(parallelizableRule(factsFor(list), rules, 2).value).toBe(false)
  })

  it("picks the preferred executor first, then the allowed list, then none", () => {
    const facts = factsFor("x")
    expect(executorRule(facts, DEV)).toEqual({ value: CLAUDE, confidence: 0.9 })
    const claudeDown = factsFor("x", {
      executors: [
        { id: CLAUDE, available: false },
        { id: CODEX, available: true },
      ],
    })
    expect(executorRule(claudeDown, DEV)).toEqual({ value: CODEX, confidence: 0.6 })
    const noneUp = factsFor("x", {
      executors: [
        { id: CLAUDE, available: false },
        { id: CODEX, available: false },
      ],
    })
    expect(executorRule(noneUp, DEV)).toEqual({ value: "none", confidence: 0 })
  })

  it("answers none with confidence 0 when the owner has no routing, even if executors are available", () => {
    expect(executorRule(factsFor("x"), WRITER)).toEqual({ value: "none", confidence: 0 })
    expect(executorRule(factsFor("x"), "new")).toEqual({ value: "none", confidence: 0 })
  })

  it("loads keyword tables and thresholds from yaml text", () => {
    const text = [
      "thresholds:",
      "  default: 0.6",
      "  perQuestion: { owner: 0.8 }",
      "intent: { code: [fix], research: [pesquisa], app_op: [posta], routine: [todo dia] }",
      "verbs: [fix]",
      "sequence: [e depois]",
      "risk: { high: [deploy], external: [push], local: [edit] }",
      "language: { pt: [que], en: [the], es: [el] }",
      "owner: { roles: [dev], leadName: lead }",
    ].join("\n")
    const custom = Effect.runSync(decodeReflexConfigText(text, "inline.yaml"))
    expect(riskRule(factsFor("push it"), compileRules(custom)).value).toBe(2)
    expect(compileRules(custom).leadName).toBe("lead")
  })
})
