import { describe, expect, it } from "vitest"
import { chunkText, escapeHtml, TELEGRAM_TEXT_LIMIT } from "../../src/telegram/format.js"

describe("escapeHtml", () => {
  it("escapes <, > and & once, so an existing entity is not double-escaped", () => {
    expect(escapeHtml("a < b & c > d &amp;")).toBe("a &lt; b &amp; c &gt; d &amp;amp;")
  })
})

describe("chunkText", () => {
  it("keeps each paragraph whole when every paragraph fits the limit", () => {
    const first = "a".repeat(3000)
    const second = "b".repeat(3000)
    const third = "c".repeat(3000)
    const chunks = chunkText(`${first}\n\n${second}\n\n${third}`)
    expect(chunks).toEqual([first, second, third])
  })

  it("packs short paragraphs together and never exceeds the limit", () => {
    const paragraphs = Array.from({ length: 40 }, (_, index) => `paragraph ${index} ${"x".repeat(300)}`)
    const chunks = chunkText(paragraphs.join("\n\n"))
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT)
      expect(chunk.startsWith("paragraph")).toBe(true)
    }
    expect(chunks.join("\n\n")).toBe(paragraphs.join("\n\n"))
  })

  it("cuts one over-long line into pieces within the limit without losing characters or splitting an emoji", () => {
    const text = "😀".repeat(3000)
    const chunks = chunkText(text)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT)
      const last = chunk.charCodeAt(chunk.length - 1)
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false)
    }
    expect(chunks.join("")).toBe(text)
  })

  it("keeps leading line breaks that belong to the content", () => {
    expect(chunkText("\n\nhello")).toEqual(["\n\nhello"])
  })

  it("returns no chunks for empty or newline-only text", () => {
    expect(chunkText("")).toEqual([])
    expect(chunkText("\n\n\n")).toEqual([])
  })
})
