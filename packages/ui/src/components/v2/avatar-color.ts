import { tokens } from "../../theme.js"

// A stable colour per Bot: the same id always maps to the same slot of the palette.
export const avatarColorFor = (id: string): string => {
  let hash = 0
  for (const char of id) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  }
  return tokens.avatarPalette[hash % tokens.avatarPalette.length] ?? tokens.color.accent
}

// "Renan" -> "RN", "dr eggbot" -> "DE": at most two letters.
export const initialsOf = (name: string): string => {
  const words = name
    .trim()
    .split(/[\s-]+/)
    .filter((word) => word !== "")
  const letters = words.length >= 2 ? [words[0]?.[0], words[1]?.[0]] : [words[0]?.[0], words[0]?.[1]]
  return letters
    .filter((letter) => letter !== undefined)
    .join("")
    .toUpperCase()
}
