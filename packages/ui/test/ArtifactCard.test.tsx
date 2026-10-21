import { type TimelineItem, TimelineItem as TimelineItemSchema } from "@shoalwork/contracts"
import { cleanup, fireEvent, screen } from "@testing-library/react"
import { Schema } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ArtifactCard, isWebLink } from "../src/components/chat/ArtifactCard.js"
import { fakeCore, iso, renderWith, TASK } from "./chat-support.js"

afterEach(cleanup)

type ArtifactItem = Extract<TimelineItem, { readonly kind: "artifact" }>

const artifact = (artifactKind: string, ref: string): ArtifactItem => {
  const item = Schema.decodeUnknownSync(TimelineItemSchema)({
    kind: "artifact",
    position: 1,
    occurredAt: iso(0),
    taskId: TASK,
    artifactKind,
    ref,
  })
  if (item.kind !== "artifact") throw new Error("not an artifact")
  return item
}

const show = (item: ArtifactItem, open: (url: string) => Promise<unknown>) =>
  renderWith(fakeCore(() => undefined).client, <ArtifactCard item={item} open={open} />)

describe("ArtifactCard links", () => {
  it.each([
    ["javascript:alert(1)"],
    ["file:///etc/passwd"],
    ["data:text/html,<script>alert(1)</script>"],
    ["not a url"],
  ])("shows %s as text with no way to open it", (ref) => {
    const open = vi.fn(async () => undefined)
    show(artifact("pr", ref), open)
    expect(screen.getByText(ref)).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Open link" })).toBeNull()
    expect(open).not.toHaveBeenCalled()
  })

  it("needs two clicks to open an https link, and opens it once", () => {
    const open = vi.fn(async () => undefined)
    show(artifact("pr", "https://example.test/pr/1"), open)
    fireEvent.click(screen.getByRole("button", { name: "Open link" }))
    expect(open).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Confirm open link" }))
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith("https://example.test/pr/1")
    expect(screen.getByRole("button", { name: "Open link" })).toBeTruthy()
  })

  it("does not open anything when the confirmation is cancelled", () => {
    const open = vi.fn(async () => undefined)
    show(artifact("url", "https://example.test/x"), open)
    fireEvent.click(screen.getByRole("button", { name: "Open link" }))
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(open).not.toHaveBeenCalled()
    expect(screen.queryByRole("button", { name: "Confirm open link" })).toBeNull()
    expect(screen.getByRole("button", { name: "Open link" })).toBeTruthy()
  })

  it("never offers a link for a file or a note, even when the text looks like a URL", () => {
    const open = vi.fn(async () => undefined)
    show(artifact("file", "https://example.test/not-a-file-link"), open)
    expect(screen.queryByRole("button", { name: "Open link" })).toBeNull()
  })

  it("accepts only http and https", () => {
    expect(isWebLink("http://a.test")).toBe(true)
    expect(isWebLink("https://a.test")).toBe(true)
    expect(isWebLink("ftp://a.test")).toBe(false)
    expect(isWebLink("javascript:alert(1)")).toBe(false)
  })
})
