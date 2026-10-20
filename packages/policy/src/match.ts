// Matching primitives for policy rules. Rule patterns come from the repo YAML, but tool inputs are hostile:
// every matcher runs in time linear in the input for a fixed pattern. No regex is built from input text.

type GlobAtom =
  | { readonly kind: "lit"; readonly ch: string }
  | { readonly kind: "one"; readonly anySlash: boolean }
  | { readonly kind: "star"; readonly anySlash: boolean }
  // Passes only where the text is at a segment start (string start or right after "/"). Written by "**/".
  | { readonly kind: "bound" }

// Path mode: "*" and "?" stay inside one segment, "**" crosses segments, and "**/" also matches zero directories.
const compileGlob = (pattern: string, pathMode: boolean): ReadonlyArray<GlobAtom> => {
  const atoms: GlobAtom[] = []
  let i = 0
  while (i < pattern.length) {
    const c = pattern.charAt(i)
    if (c === "*") {
      let run = 0
      while (pattern.charAt(i + run) === "*") {
        run++
      }
      i += run
      if (!pathMode) {
        atoms.push({ kind: "star", anySlash: true })
      } else if (run >= 2) {
        atoms.push({ kind: "star", anySlash: true })
        if (pattern.charAt(i) === "/") {
          i++
          atoms.push({ kind: "bound" })
        }
      } else {
        atoms.push({ kind: "star", anySlash: false })
      }
      continue
    }
    i++
    atoms.push(c === "?" ? { kind: "one", anySlash: !pathMode } : { kind: "lit", ch: c })
  }
  return atoms
}

// Epsilon moves: a star may match nothing; a bound passes only at a segment start.
const closeStars = (atoms: ReadonlyArray<GlobAtom>, set: Uint8Array, atBoundary: boolean): void => {
  for (let s = 0; s < atoms.length; s++) {
    if (set[s] !== 1) {
      continue
    }
    const kind = atoms[s]?.kind
    if (kind === "star" || (kind === "bound" && atBoundary)) {
      set[s + 1] = 1
    }
  }
}

// Thompson-style simulation over the pattern states: O(text × pattern), no backtracking.
export const globMatch = (pattern: string, text: string, pathMode: boolean): boolean => {
  if (!pattern.includes("*") && !pattern.includes("?")) {
    return pattern === text
  }
  const atoms = compileGlob(pattern, pathMode)
  const m = atoms.length
  let current = new Uint8Array(m + 1)
  let next = new Uint8Array(m + 1)
  current[0] = 1
  closeStars(atoms, current, true)
  for (let k = 0; k < text.length; k++) {
    const ch = text.charAt(k)
    next.fill(0)
    let alive = false
    for (let s = 0; s < m; s++) {
      if (current[s] !== 1) {
        continue
      }
      const atom = atoms[s]
      if (atom === undefined || atom.kind === "bound") {
        continue
      }
      if (atom.kind === "star") {
        if (atom.anySlash || ch !== "/") {
          next[s] = 1
          alive = true
        }
      } else if (atom.kind === "one") {
        if (atom.anySlash || ch !== "/") {
          next[s + 1] = 1
          alive = true
        }
      } else if (atom.ch === ch) {
        next[s + 1] = 1
        alive = true
      }
    }
    if (!alive) {
      return false
    }
    closeStars(atoms, next, ch === "/")
    const swap = current
    current = next
    next = swap
  }
  return current[m] === 1
}

const closeTokenStars = (pattern: ReadonlyArray<string>, set: Uint8Array): void => {
  for (let s = 0; s < pattern.length; s++) {
    if (set[s] === 1 && pattern[s] === "*") {
      set[s + 1] = 1
    }
  }
}

// Token-level match of a Bash pattern against one argv. A pattern word "*" matches zero or more words;
// other words are word globs (no path semantics).
export const argvMatch = (pattern: ReadonlyArray<string>, argv: ReadonlyArray<string>): boolean => {
  const m = pattern.length
  let current = new Uint8Array(m + 1)
  let next = new Uint8Array(m + 1)
  current[0] = 1
  closeTokenStars(pattern, current)
  for (const word of argv) {
    next.fill(0)
    let alive = false
    for (let s = 0; s < m; s++) {
      if (current[s] !== 1) {
        continue
      }
      const p = pattern[s]
      if (p === undefined) {
        continue
      }
      if (p === "*") {
        next[s] = 1
        alive = true
      } else if (globMatch(p, word, false)) {
        next[s + 1] = 1
        alive = true
      }
    }
    if (!alive) {
      return false
    }
    closeTokenStars(pattern, next)
    const swap = current
    current = next
    next = swap
  }
  return current[m] === 1
}

export interface ToolPattern {
  readonly name: string
  // Text inside the parentheses, e.g. "git push *" for Bash(git push *). Undefined when there are none.
  readonly spec: string | undefined
}

const isNameChar = (c: string): boolean => /^[A-Za-z0-9_.*-]$/.test(c)

// Claude Code syntax: "Name" or "Name(spec)". Returns undefined for anything malformed.
export const parseToolPattern = (tool: string): ToolPattern | undefined => {
  const open = tool.indexOf("(")
  if (open === -1) {
    if (tool.length === 0 || tool.includes(")") || ![...tool].every(isNameChar)) {
      return undefined
    }
    return { name: tool, spec: undefined }
  }
  if (!tool.endsWith(")")) {
    return undefined
  }
  const name = tool.slice(0, open)
  const spec = tool.slice(open + 1, -1)
  if (name.length === 0 || ![...name].every(isNameChar) || name.includes("*")) {
    return undefined
  }
  if (spec.trim().length === 0 || spec.includes("(") || spec.includes(")")) {
    return undefined
  }
  return { name, spec: spec.trim() }
}

// Bash spec words: plain words and "*" wildcards only. Shell syntax in a rule is a config error.
const FORBIDDEN_SPEC_CHARS = [
  ";",
  "&",
  "|",
  "(",
  ")",
  "$",
  "`",
  "<",
  ">",
  '"',
  "'",
  "\\",
  "\n",
  "\r",
  "#",
  "[",
  "]",
  "{",
  "}",
]

export const parseArgvPattern = (spec: string): ReadonlyArray<string> | undefined => {
  if (FORBIDDEN_SPEC_CHARS.some((c) => spec.includes(c))) {
    return undefined
  }
  const words = spec.split(/\s+/).filter((w) => w.length > 0)
  return words.length > 0 ? words : undefined
}

export const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1)
