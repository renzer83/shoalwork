// Telegram limit for sendMessage, counted on the text after HTML entity parsing (the escaped source may be longer).
export const TELEGRAM_TEXT_LIMIT = 4096

export const escapeHtml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

// Lookbehind keeps each separator with the piece before it, so joining the pieces restores the text.
const PARAGRAPH = /(?<=\n\n)/
const LINE = /(?<=\n)/

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff

// Hard cut for a piece that has no line break inside the limit. Never splits a surrogate pair.
const hardSplit = (piece: string, limit: number): Array<string> => {
  const pieces: Array<string> = []
  let rest = piece
  while (rest.length > limit) {
    let cut = limit
    if (cut > 1 && isHighSurrogate(rest.charCodeAt(cut - 1))) {
      cut -= 1
    }
    pieces.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest.length > 0) {
    pieces.push(rest)
  }
  return pieces
}

// Every returned piece is at most `limit` long; breaks prefer lines, then characters.
const fit = (piece: string, limit: number): Array<string> => {
  if (piece.length <= limit) {
    return [piece]
  }
  const lines = piece.split(LINE)
  if (lines.length > 1) {
    return lines.flatMap((line) => fit(line, limit))
  }
  return hardSplit(piece, limit)
}

// Greedy packing by paragraph: a paragraph goes whole into a chunk whenever it fits.
export const chunkText = (text: string, limit: number = TELEGRAM_TEXT_LIMIT): Array<string> => {
  const pieces = text.split(PARAGRAPH).flatMap((paragraph) => fit(paragraph, limit))
  const chunks: Array<string> = []
  let current = ""
  for (const piece of pieces) {
    if (current.length > 0 && current.length + piece.length > limit) {
      chunks.push(current)
      current = ""
    }
    current += piece
  }
  if (current.length > 0) {
    chunks.push(current)
  }
  // Trailing separators go; leading ones are content and stay. Blank chunks are never sent.
  return chunks.map((chunk) => chunk.replace(/\n+$/, "")).filter((chunk) => chunk.trim().length > 0)
}
