/// <reference lib="dom" />

import { BotDetail } from "@shoalwork/api-client"
import { TimelineItem } from "@shoalwork/contracts"
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react"
import { Schema } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BranchCard } from "../../src/components/v2/chat/BranchCard.js"
import { LinkCard, serviceIcon } from "../../src/components/v2/chat/LinkCard.js"
import { PrCard, prNumberOf } from "../../src/components/v2/chat/PrCard.js"
import { ConversationScreen } from "../../src/screens/v2/ConversationScreen.js"
import {
  describeBot,
  fallbackOf,
  modelOf,
  recentFiles,
  usefulLinks,
} from "../../src/screens/v2/conversation-model.js"
import { ShellContext } from "../../src/shell/shell-context.js"
import {
  APPROVAL,
  approvalItem,
  costsEmpty,
  detail,
  fakeCore,
  iso,
  json,
  LOAD,
  message,
  OBRA,
  page,
  renderPt,
  TASK,
} from "./support.js"

const viewport = vi.hoisted(() => ({ width: 1585 }))

vi.mock("react-native", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-native")>()
  return {
    ...actual,
    useWindowDimensions: () => ({ width: viewport.width, height: 992, scale: 1, fontScale: 1 }),
  }
})

beforeEach(() => {
  viewport.width = 1585
})
afterEach(cleanup)

const PR_URL = "https://github.com/acme/obra/pull/482"
const FIGMA_URL = "https://www.figma.com/file/abc/layout"
const HOSTILE = '<img src=x onerror="alert(1)"> **not bold**'

const artifact = (position: number, artifactKind: string, ref: string, summary?: string) => ({
  kind: "artifact",
  position,
  occurredAt: iso(position),
  taskId: TASK,
  artifactKind,
  ref,
  ...(summary === undefined ? {} : { summary }),
})

const fileEdit = (position: number, text: string, offsetSeconds = position) => ({
  kind: "event",
  position,
  occurredAt: iso(offsetSeconds),
  name: "file_edit",
  taskId: TASK,
  text,
})

const ITEMS = [
  message(
    1,
    "out",
    `Analisei o feedback.\n- Lista de telas revisada\n- Componente Card ajustado\n${HOSTILE}`,
  ),
  message(2, "in", "Ficou muito bom."),
  // Two bursts of edits a minute apart: the timeline folds each into a chip, the screen shows one chip.
  fileEdit(3, "src/components/Card.tsx"),
  fileEdit(4, "src/layout/Header.tsx", 60),
  message(5, "out", "PR criado e pronto para revisão.", 70),
  artifact(6, "pr", PR_URL, "Ajuste do layout"),
  artifact(7, "url", FIGMA_URL, "ObraBoss – Layout v2"),
  artifact(8, "file", "docs/notes.txt", "Notas"),
  approvalItem(9, "pending"),
]

const setup = (
  items: ReadonlyArray<unknown> = ITEMS,
  shell?: { openSearch?: () => void; narrow?: boolean },
  detailResponse: () => Response = () => json({ bot: detail(OBRA, "obraboss-ux", { project: "ObraBoss" }) }),
) => {
  const core = fakeCore((call) => {
    if (call.path === "/bots/obraboss-ux") return detailResponse()
    if (call.path.startsWith("/costs")) return costsEmpty()
    if (call.method === "GET" && call.path.startsWith("/messages?")) {
      const after = new URL(`http://core.test${call.path}`).searchParams.get("after")
      return json(page(OBRA, after === null ? items : []))
    }
    if (call.method === "POST" && call.path === "/messages")
      return json({ eventId: "evt_00000000-0000-4000-8000-0000000000ff" })
    if (call.method === "POST" && call.path === `/approvals/${APPROVAL}`) {
      return json({
        result: "resolved",
        approval: {
          id: APPROVAL,
          taskId: TASK,
          botId: OBRA,
          action: { tool: "Bash", input: "rm -rf build" },
          risk: "irreversible",
          status: "approved",
          requestedAt: iso(0),
          expiresAt: iso(3600),
          resolvedAt: iso(9),
          resolvedBy: "user:web",
        },
      })
    }
    return undefined
  })
  const open = vi.fn(async () => undefined)
  renderPt(
    core.client,
    <ShellContext.Provider
      value={{
        narrow: shell?.narrow ?? false,
        openList: () => undefined,
        openSearch: shell?.openSearch ?? (() => undefined),
      }}
    >
      <ConversationScreen bot="obraboss-ux" open={open} />
    </ShellContext.Provider>,
  )
  return { core, open }
}

describe("ConversationScreen", () => {
  it("renders a card for each kind of timeline item, as plain text", async () => {
    setup()
    await screen.findByText("Analisei o feedback.", {}, LOAD)
    // Message: bullets become list items, the rest is text and nothing is parsed.
    expect(screen.getByText("Lista de telas revisada")).toBeTruthy()
    expect(screen.getAllByText("•")).toHaveLength(2)
    expect(screen.getByText(HOSTILE)).toBeTruthy()
    expect(document.querySelector("img")).toBeNull()
    expect(screen.getByText("Ficou muito bom.")).toBeTruthy()
    expect(screen.getByText("Você")).toBeTruthy()
    // Folded edits, PR, link, plain artifact and approval.
    expect(screen.getByText("2 arquivos editados · src/layout/Header.tsx")).toBeTruthy()
    expect(screen.getByText("#482 Ajuste do layout")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Ver PR" })).toBeTruthy()
    expect(screen.getByLabelText("Link para figma.com")).toBeTruthy()
    expect(screen.getByText("ObraBoss – Layout v2")).toBeTruthy()
    expect(screen.getByText("docs/notes.txt")).toBeTruthy()
    expect(screen.getByText("Solicitação de aprovação")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Aprovar" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Revisar" })).toBeTruthy()
  })

  it("fills the header chips and the Bot panel from the ficha and the timeline", async () => {
    setup()
    await screen.findByText("Analisei o feedback.", {}, LOAD)
    expect(screen.getAllByText("ObraBoss").length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText("claude-code").length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText("sonnet-4.5").length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText("Sobre este bot")).toBeTruthy()
    expect(screen.getByText("Cuida do layout e da experiência do usuário.")).toBeTruthy()
    expect(screen.queryByText(/Segundo parágrafo/)).toBeNull()
    expect(screen.getByText("codex")).toBeTruthy()
    expect(screen.getByText("src/components/Card.tsx")).toBeTruthy()
    expect(screen.getByText("src/layout/Header.tsx")).toBeTruthy()
    expect(screen.getByText("Links úteis")).toBeTruthy()
    expect(screen.getAllByText("github.com").length).toBeGreaterThanOrEqual(1)
  })

  it("Aprovar calls approvals.resolve and closes the card", async () => {
    const { core } = setup()
    fireEvent.click(await screen.findByRole("button", { name: "Aprovar" }, LOAD))
    await waitFor(() => expect(screen.queryByRole("button", { name: "Aprovar" })).toBeNull(), LOAD)
    expect(core.calls.filter((call) => call.method === "POST" && call.path.startsWith("/approvals"))).toEqual(
      [{ method: "POST", path: `/approvals/${APPROVAL}`, body: { decision: "approved", via: "web" } }],
    )
  })

  it("Enter sends the message and clears the field", async () => {
    const { core } = setup([])
    const box = await screen.findByRole("textbox", { name: "Fale com obraboss-ux..." }, LOAD)
    fireEvent.change(box, { target: { value: "oi equipe" } })
    fireEvent.keyDown(box, { key: "Enter" })
    await waitFor(
      () => expect(core.calls.some((call) => call.method === "POST" && call.path === "/messages")).toBe(true),
      LOAD,
    )
    expect(core.calls.find((call) => call.method === "POST" && call.path === "/messages")?.body).toEqual({
      botId: "obraboss-ux",
      text: "oi equipe",
    })
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(""), LOAD)
  })

  it("⌘↵ breaks the line and does not send", async () => {
    const { core } = setup([])
    const box = await screen.findByRole("textbox", { name: "Fale com obraboss-ux..." }, LOAD)
    fireEvent.change(box, { target: { value: "linha 1" } })
    fireEvent.keyDown(box, { key: "Enter", metaKey: true })
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe("linha 1\n"), LOAD)
    expect(core.calls.some((call) => call.method === "POST" && call.path === "/messages")).toBe(false)
  })

  it("does not send an empty message and keeps the voice button off", async () => {
    const { core } = setup([])
    const box = await screen.findByRole("textbox", { name: "Fale com obraboss-ux..." }, LOAD)
    fireEvent.keyDown(box, { key: "Enter" })
    expect(core.calls.some((call) => call.method === "POST")).toBe(false)
    expect(screen.getByRole("button", { name: "Voz (em breve)" }).getAttribute("aria-disabled")).toBe("true")
    expect(screen.getByRole("button", { name: "Enviar" }).getAttribute("aria-disabled")).toBe("true")
  })

  it("closes the panel with ✕ and brings it back from the … button", async () => {
    setup()
    await screen.findByText("Sobre este bot", {}, LOAD)
    fireEvent.click(screen.getByRole("button", { name: "Fechar painel" }))
    expect(screen.queryByText("Sobre este bot")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Painel do Bot" }))
    expect(screen.getByText("Sobre este bot")).toBeTruthy()
  })

  it("has no panel on a window too small for it, and the chevron opens the sidebar search", async () => {
    viewport.width = 900
    const openSearch = vi.fn()
    setup(ITEMS, { openSearch })
    await screen.findByText("Analisei o feedback.", {}, LOAD)
    expect(screen.queryByText("Sobre este bot")).toBeNull()
    expect(screen.queryByRole("button", { name: "Painel do Bot" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Trocar Bot" }))
    expect(openSearch).toHaveBeenCalledTimes(1)
  })

  it("asks before opening a link and only opens http(s)", async () => {
    const { open } = setup()
    await screen.findByText("Analisei o feedback.", {}, LOAD)
    fireEvent.click(screen.getByRole("button", { name: "Ver PR" }))
    expect(open).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Abrir github.com no navegador" }))
    expect(open).toHaveBeenCalledWith(PR_URL)
  })
})

describe("ConversationScreen layout and input", () => {
  const bubbleOf = (text: string): HTMLElement => {
    const bubble = screen.getByText(text).closest('[data-testid="message-bubble"]')
    if (!(bubble instanceof HTMLElement)) throw new Error(`no bubble around ${text}`)
    return bubble
  }

  it("hangs the artifacts of a Bot message inside its bubble, and shows one chip for the edits", async () => {
    setup()
    await screen.findByText("PR criado e pronto para revisão.", {}, LOAD)
    const bubble = within(bubbleOf("PR criado e pronto para revisão."))
    expect(bubble.getByText("#482 Ajuste do layout")).toBeTruthy()
    expect(bubble.getByText("github.com")).toBeTruthy()
    expect(bubble.getByLabelText("Link para figma.com")).toBeTruthy()
    expect(bubble.getByText("docs/notes.txt")).toBeTruthy()
    // The approval is its own card, not part of the bubble.
    expect(screen.getByText("Solicitação de aprovação").closest('[data-testid="message-bubble"]')).toBeNull()
    expect(screen.getAllByText(/arquivos editados/)).toHaveLength(1)
  })

  it("gives an artifact with no Bot message before it its own box", async () => {
    setup([fileEdit(1, "src/a.ts"), artifact(2, "url", FIGMA_URL, "Protótipo")])
    await screen.findByText("Protótipo", {}, LOAD)
    expect(screen.getByText("Protótipo").closest('[data-testid="message-bubble"]')).toBeNull()
  })

  it("says so, with a way to retry, when the Bot ficha cannot be read", async () => {
    let calls = 0
    setup([], undefined, () => {
      calls += 1
      return calls === 1
        ? json({ error: "boom" }, 500)
        : json({ bot: detail(OBRA, "obraboss-ux", { project: "ObraBoss" }) })
    })
    const alert = await screen.findByRole("alert", {}, LOAD)
    expect(alert.textContent).toContain("HTTP 500")
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }))
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull(), LOAD)
    expect(await screen.findByText("Sobre este bot", {}, LOAD)).toBeTruthy()
  })

  it("does not send on an Enter that confirms an IME candidate, nor on Shift+Enter", async () => {
    const { core } = setup([])
    const box = await screen.findByRole("textbox", { name: "Fale com obraboss-ux..." }, LOAD)
    fireEvent.change(box, { target: { value: "にほん" } })
    fireEvent.keyDown(box, { key: "Enter", isComposing: true })
    fireEvent.keyDown(box, { key: "Enter", keyCode: 229 })
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true })
    expect(core.calls.some((call) => call.method === "POST")).toBe(false)
    expect((box as HTMLTextAreaElement).value).toBe("にほん")
  })

  it("Ctrl+Enter breaks the line at the caret, not at the end", async () => {
    const { core } = setup([])
    const box = (await screen.findByRole(
      "textbox",
      { name: "Fale com obraboss-ux..." },
      LOAD,
    )) as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: "linha 1" } })
    box.setSelectionRange(2, 2)
    fireEvent.select(box)
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true })
    await waitFor(() => expect(box.value).toBe("li\nnha 1"), LOAD)
    expect(core.calls.some((call) => call.method === "POST")).toBe(false)
  })

  it("replaces the selection when it breaks the line", async () => {
    setup([])
    const box = (await screen.findByRole(
      "textbox",
      { name: "Fale com obraboss-ux..." },
      LOAD,
    )) as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: "abcdef" } })
    box.setSelectionRange(1, 4)
    fireEvent.select(box)
    fireEvent.keyDown(box, { key: "Enter", metaKey: true })
    await waitFor(() => expect(box.value).toBe("a\nef"), LOAD)
  })

  it("fills the send button blue once there is text", async () => {
    setup([])
    const box = await screen.findByRole("textbox", { name: "Fale com obraboss-ux..." }, LOAD)
    const send = screen.getByRole("button", { name: "Enviar" })
    expect(send.getAttribute("aria-disabled")).toBe("true")
    fireEvent.change(box, { target: { value: "oi" } })
    expect(send.getAttribute("aria-disabled")).not.toBe("true")
    expect(send.style.backgroundColor).toBe("rgb(47, 123, 255)")
    expect(send.style.opacity).toBe("1")
  })
})

describe("v2 cards", () => {
  it("BranchCard shows the branch, the files and the diff, and the button acts", () => {
    const onViewFiles = vi.fn()
    renderPt(
      fakeCore(() => undefined).client,
      <BranchCard
        branch="feature/layout-v2"
        filesChanged={3}
        added={128}
        removed={12}
        onViewFiles={onViewFiles}
      />,
    )
    expect(screen.getByText("feature/layout-v2")).toBeTruthy()
    expect(screen.getByText("3 arquivos alterados")).toBeTruthy()
    expect(screen.getByText("+128")).toBeTruthy()
    expect(screen.getByText("−12")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Ver arquivos" }))
    expect(onViewFiles).toHaveBeenCalledTimes(1)
  })

  it("PrCard shows number, route and state; LinkCard hides the button for a non-web link", () => {
    renderPt(
      fakeCore(() => undefined).client,
      <>
        <PrCard url={PR_URL} title="Ajuste" number={482} route="feature/layout-v2 → main" state="open" />
        <LinkCard url="javascript:alert(1)" title="Perigo" />
      </>,
    )
    expect(screen.getByText("#482 Ajuste")).toBeTruthy()
    expect(screen.getByText("feature/layout-v2 → main · github.com")).toBeTruthy()
    expect(screen.getByText("Aberto")).toBeTruthy()
    expect(screen.getByText("Perigo")).toBeTruthy()
    expect(screen.queryAllByRole("button", { name: "Abrir" })).toHaveLength(0)
  })

  it("reads the PR number only from GitHub hosts", () => {
    expect(prNumberOf(PR_URL)).toBe(482)
    expect(prNumberOf("https://gist.github.com/o/r/pull/7")).toBe(7)
    expect(prNumberOf("https://example.test/x")).toBeUndefined()
    expect(prNumberOf("https://notgithub.com/o/r/pull/482")).toBeUndefined()
    expect(prNumberOf("https://github.com.evil.test/o/r/pull/482")).toBeUndefined()
  })

  it("PrCard shows the host under the title and keeps #N and the GitHub mark for GitHub only", () => {
    const { unmount } = renderPt(
      fakeCore(() => undefined).client,
      <PrCard url={PR_URL} title="Ajuste" number={482} route="feature/x → main" state="open" />,
    )
    expect(screen.getByText("feature/x → main · github.com")).toBeTruthy()
    expect(screen.getByText("#482 Ajuste")).toBeTruthy()
    const githubMark = screen.getByLabelText("Pull request: Ajuste").querySelector("path")?.getAttribute("d")
    unmount()
    renderPt(
      fakeCore(() => undefined).client,
      <PrCard url="https://git.example.test/o/r/pull/9" title="Outro" number={9} />,
    )
    expect(screen.getByText("git.example.test")).toBeTruthy()
    expect(screen.getByText("Outro")).toBeTruthy()
    expect(screen.queryByText(/#9/)).toBeNull()
    expect(screen.getByLabelText("Pull request: Outro").querySelector("path")?.getAttribute("d")).not.toBe(
      githubMark,
    )
  })

  it("picks the service mark by host, with no look-alike matching", () => {
    expect(serviceIcon("figma.com")).toBe("figma")
    expect(serviceIcon("embed.figma.com")).toBe("figma")
    expect(serviceIcon("notfigma.com")).toBe("link")
    expect(serviceIcon("figma.com.evil.test")).toBe("link")
    expect(serviceIcon("github.com")).toBe("github")
    expect(serviceIcon("gist.github.com")).toBe("github")
    expect(serviceIcon("evilgithub.com")).toBe("link")
  })
})

describe("conversation model", () => {
  const items = Schema.decodeUnknownSync(Schema.Array(TimelineItem))(ITEMS)

  it("lists recent files newest first and links without repeats", () => {
    expect(recentFiles(items)).toEqual(["src/layout/Header.tsx", "src/components/Card.tsx"])
    expect(usefulLinks(items)).toEqual([FIGMA_URL, PR_URL])
  })

  it("describes a Bot by the first paragraph of its instructions, clipped", () => {
    expect(describeBot("Uma  linha\ncontinua aqui.\n\nOutra.")).toBe("Uma linha continua aqui.")
    expect(describeBot("x".repeat(400)).length).toBe(180)
  })

  it("picks the model and the fallback from the ficha", () => {
    const bot = Schema.decodeUnknownSync(BotDetail)(detail(OBRA, "obraboss-ux"))
    expect(modelOf(bot)).toBe("sonnet-4.5")
    expect(fallbackOf(bot)).toBe("codex")
    const bare = Schema.decodeUnknownSync(BotDetail)(
      detail(OBRA, "xx", {
        modelTiers: {},
        executors: { preferred: "claude-code", allowed: ["claude-code"] },
      }),
    )
    expect(modelOf(bare)).toBeUndefined()
    expect(fallbackOf(bare)).toBeUndefined()
  })
})
