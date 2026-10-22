import type { ApiClient, BotSummary } from "@shoalwork/api-client"
import { render } from "@testing-library/react"
import type { ReactNode } from "react"
import { PaperProvider } from "react-native-paper"
import { LocaleProvider, StaticApiProvider, themeFor } from "../../src/index.js"
import { BOT, json } from "../chat-support.js"

export {
  APPROVAL,
  approvalItem,
  BOT,
  commandEvent,
  eventId,
  fakeCore,
  iso,
  json,
  message,
  TASK,
} from "../chat-support.js"

// A Bot the sidebar lists: `project` is what the groups are made from.
export const summary = (
  id: string,
  name: string,
  project?: string,
  state: BotSummary["state"] = "idle",
): BotSummary => ({
  id,
  name,
  role: name === "lead" ? "coordinator" : "developer",
  state,
  ...(project === undefined ? {} : { project }),
})

// The wait bound of this package's tests: a loaded runner renders a screen in seconds.
export const LOAD = { timeout: 10_000 }

// A sidebar row is named "<bot>, <last message>, <time>" once it has a preview, just "<bot>" before.
export const rowName = (name: string): RegExp => new RegExp(`^${name}(,|$)`)

export const LEAD = "bot_00000000-0000-4000-8000-0000000000a0"
export const OBRA = "bot_00000000-0000-4000-8000-0000000000a1"
export const FATU = "bot_00000000-0000-4000-8000-0000000000a2"
export const SOLO = "bot_00000000-0000-4000-8000-0000000000a3"

export const BOTS = [
  summary(LEAD, "lead"),
  summary(OBRA, "obraboss-ux", "ObraBoss"),
  summary(FATU, "faturium-dev", "Faturium"),
  summary(SOLO, "seo-desk"),
]

// The ficha as GET /bots/:idOrName answers it.
export const detail = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  role: "developer",
  instructions: "Cuida do layout e da experiência do usuário.\n\nSegundo parágrafo que não aparece.",
  kind: "auxiliary",
  executors: { preferred: "claude-code", allowed: ["claude-code", "codex"] },
  modelTiers: { chat: { executor: "claude-code", model: "sonnet-4.5" } },
  connectors: [],
  budget: { tokens: 300000, seconds: 900, usd: 3 },
  policy: "default",
  tank: { mode: "local", host: "mac" },
  memory: { scope: "bot" },
  state: "idle",
  ...extra,
})

export const page = (botId: string, items: ReadonlyArray<unknown>, head = 40) => ({
  botId,
  items,
  nextBefore: null,
  head,
})

export const costsEmpty = () => json({ rows: [], delta: { tokensInPct: null, okRatePct: null } })

export const renderPt = (client: ApiClient, ui: ReactNode) =>
  render(
    <PaperProvider theme={themeFor("dark")}>
      <LocaleProvider locale="pt-BR">
        <StaticApiProvider client={client}>{ui}</StaticApiProvider>
      </LocaleProvider>
    </PaperProvider>,
  )

export { BOT as BOT_ID }
