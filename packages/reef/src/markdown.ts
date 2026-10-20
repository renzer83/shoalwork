// Pure markdown chunking for the Reef importer: no I/O, no Effect. Chunks follow headings, stay within a size limit
// and are cut on paragraph boundaries; fenced code longer than MAX_CODE_LINES is replaced by a placeholder.

export const MAX_CHUNK_CHARS = 1500
export const MAX_CODE_LINES = 40
const HEADING = /^#{1,3}\s/
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/

// Removes the YAML frontmatter block when the first line is "---" and a closing "---" line exists.
const stripFrontmatter = (lines: ReadonlyArray<string>): ReadonlyArray<string> => {
  if (lines[0]?.trimEnd() !== "---") {
    return lines
  }
  const close = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---")
  return close === -1 ? lines : lines.slice(close + 1)
}

// Hard cut for one paragraph longer than the limit; never splits a surrogate pair.
const sliceHard = (text: string): Array<string> => {
  const parts: Array<string> = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(start + MAX_CHUNK_CHARS, text.length)
    const last = text.charCodeAt(end - 1)
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) {
      end -= 1
    }
    parts.push(text.slice(start, end))
    start = end
  }
  return parts
}

const PARAGRAPH_SEP = "\n\n"

// Greedy packing of one section's paragraphs. A new piece opens with the previous piece's last paragraph (one
// paragraph of overlap) when that still fits.
const pack = (paragraphs: ReadonlyArray<string>): Array<string> => {
  const pieces: Array<string> = []
  let current: Array<string> = []
  const emit = (): void => {
    if (current.length > 0) {
      pieces.push(current.join(PARAGRAPH_SEP))
    }
  }
  for (const paragraph of paragraphs) {
    if (paragraph.length > MAX_CHUNK_CHARS) {
      emit()
      current = []
      pieces.push(...sliceHard(paragraph))
      continue
    }
    const grown = [...current, paragraph]
    if (grown.join(PARAGRAPH_SEP).length <= MAX_CHUNK_CHARS) {
      current = grown
      continue
    }
    const previous = current.at(-1)
    emit()
    const withOverlap = previous === undefined ? [paragraph] : [previous, paragraph]
    current = withOverlap.join(PARAGRAPH_SEP).length <= MAX_CHUNK_CHARS ? withOverlap : [paragraph]
  }
  emit()
  return pieces
}

interface Fence {
  readonly marker: string
  readonly lines: Array<string>
  body: number
}

// Pure: markdown text in, chunks out. Sections start at #, ##, ### headings; a fenced block is never split by a
// heading inside it; a block longer than MAX_CODE_LINES is replaced by a placeholder.
export const chunkMarkdown = (text: string): ReadonlyArray<string> => {
  const lines = stripFrontmatter(text.replace(/\r\n/g, "\n").split("\n"))
  let section: Array<string> = []
  const sections: Array<Array<string>> = [section]
  let paragraph: Array<string> = []
  let fence: Fence | undefined

  const flush = (): void => {
    if (paragraph.length > 0) {
      section.push(paragraph.join("\n"))
      paragraph = []
    }
  }
  const closeFence = (open: Fence, closing?: string): void => {
    section.push(
      open.body > MAX_CODE_LINES
        ? `[code omitted: ${open.body} lines]`
        : [...open.lines, ...(closing === undefined ? [] : [closing])].join("\n"),
    )
  }

  for (const line of lines) {
    if (fence !== undefined) {
      const run = FENCE_CLOSE.exec(line)?.[1]
      if (run !== undefined && run[0] === fence.marker[0] && run.length >= fence.marker.length) {
        closeFence(fence, line)
        fence = undefined
      } else {
        fence.lines.push(line)
        fence.body += 1
      }
      continue
    }
    const opening = FENCE_OPEN.exec(line)?.[1]
    if (opening !== undefined) {
      flush()
      fence = { marker: opening, lines: [line], body: 0 }
      continue
    }
    if (line.trim() === "") {
      flush()
      continue
    }
    if (HEADING.test(line)) {
      flush()
      section = [line]
      sections.push(section)
      continue
    }
    paragraph.push(line)
  }
  flush()
  if (fence !== undefined) {
    closeFence(fence)
  }
  return sections.flatMap((paragraphs) => pack(paragraphs)).filter((piece) => piece.trim() !== "")
}
