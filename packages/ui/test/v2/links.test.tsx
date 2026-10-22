/// <reference lib="dom" />
import { cleanup, fireEvent, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LinkCard } from "../../src/components/v2/chat/LinkCard.js"
import { hostOf, isHostOf, isWebUrl, LinkAction } from "../../src/components/v2/chat/open-link.js"
import { fakeCore, renderPt } from "./support.js"

afterEach(cleanup)

const client = () => fakeCore(() => undefined).client

describe("isWebUrl", () => {
  it("accepts plain http and https links", () => {
    expect(isWebUrl("https://example.test/a?b=1#c")).toBe(true)
    expect(isWebUrl("http://example.test")).toBe(true)
    expect(isWebUrl("https://sub.example.test:8443/x")).toBe(true)
  })

  it("refuses every other scheme, upper-case schemes and links with credentials", () => {
    for (const ref of [
      "mailto:a@example.test",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<b>x</b>",
      "ftp://example.test/x",
      "HTTP://example.test",
      "Https://example.test",
      "https://user:pass@example.test/",
      "https://user@example.test/",
      "//example.test/x",
      " https://example.test",
      "not a url",
      "",
    ]) {
      expect(isWebUrl(ref), ref).toBe(false)
    }
  })
})

describe("hosts", () => {
  it("reads the host without www and matches a domain or its subdomains only", () => {
    expect(hostOf("https://www.figma.com/file/x")).toBe("figma.com")
    expect(hostOf("nonsense")).toBe("nonsense")
    expect(isHostOf("gist.github.com", "github.com")).toBe(true)
    expect(isHostOf("github.com", "github.com")).toBe(true)
    expect(isHostOf("notgithub.com", "github.com")).toBe(false)
    expect(isHostOf("github.com.evil.test", "github.com")).toBe(false)
  })
})

describe("LinkAction", () => {
  it("asks first, names the host in the confirmation and opens only after it", () => {
    const open = vi.fn(async () => undefined)
    renderPt(client(), <LinkAction url="https://www.figma.com/file/x" label="Abrir" open={open} />)
    fireEvent.click(screen.getByRole("button", { name: "Abrir" }))
    expect(open).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Abrir figma.com no navegador" }))
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith("https://www.figma.com/file/x")
  })

  it("Cancelar goes back to the button and never opens", () => {
    const open = vi.fn(async () => undefined)
    renderPt(client(), <LinkAction url="https://example.test/x" label="Abrir" open={open} />)
    fireEvent.click(screen.getByRole("button", { name: "Abrir" }))
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }))
    expect(open).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Abrir" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: /no navegador/ })).toBeNull()
  })

  it("renders no button, and never calls open, for a link that is not plain http(s)", () => {
    const open = vi.fn(async () => undefined)
    for (const url of [
      "mailto:a@example.test",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "HTTP://example.test",
      "https://u:p@example.test/",
    ]) {
      const { unmount } = renderPt(client(), <LinkCard url={url} title="Texto" open={open} />)
      expect(screen.getByText("Texto")).toBeTruthy()
      expect(screen.queryAllByRole("button")).toHaveLength(0)
      unmount()
    }
    expect(open).not.toHaveBeenCalled()
  })
})
