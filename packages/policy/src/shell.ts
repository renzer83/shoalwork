// Bash command lexer: splits a command into simple commands and their words, without a shell.
// Quote removal is exact; anything the lexer cannot follow is marked opaque or compound, never allowed.

export interface ShellSegment {
  // Words after quote removal. Leading env assignments (FOO=1) are not in argv.
  readonly argv: ReadonlyArray<string>
  // True when the segment has unquoted expansion, glob, comment or env prefix: argv is the literal text and
  // does not show what the shell will run. Opaque segments are never allowed by rules.
  readonly opaque: boolean
}

export interface ShellParse {
  readonly segments: ReadonlyArray<ShellSegment>
  // More than one simple command, an opaque segment, a lexical error or command substitution: never allowed.
  readonly compound: boolean
  readonly unterminated: boolean
}

const SEPARATORS: ReadonlySet<string> = new Set([
  ";",
  "&",
  "|",
  "(",
  ")",
  "{",
  "}",
  "<",
  ">",
  "`",
  "\n",
  "\r",
])
const OPAQUE_CHARS: ReadonlySet<string> = new Set(["$", "*", "?", "[", "]", "~", "#"])
const ESCAPABLE_IN_DOUBLE_QUOTES: ReadonlySet<string> = new Set(['"', "\\", "$", "`"])

export const isAssignment = (word: string): boolean => {
  const eq = word.indexOf("=")
  return eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(word.slice(0, eq))
}

interface Lexed {
  readonly segments: ReadonlyArray<ShellSegment>
  readonly unterminated: boolean
}

// One pass over the text. Separators split simple commands; quotes only protect the words inside them.
const lexShell = (command: string): Lexed => {
  const segments: ShellSegment[] = []
  let argv: string[] = []
  let word = ""
  let inWord = false
  let opaque = false
  let unterminated = false

  const flushWord = (): void => {
    if (inWord) {
      argv.push(word)
    }
    word = ""
    inWord = false
  }
  const flushSegment = (): void => {
    flushWord()
    let start = 0
    while (start < argv.length && isAssignment(argv[start] ?? "")) {
      start++
      opaque = true
    }
    const words = argv.slice(start)
    if (words.length > 0 || opaque) {
      segments.push({ argv: words, opaque })
    }
    argv = []
    opaque = false
  }

  let i = 0
  const n = command.length
  while (i < n) {
    const c = command.charAt(i)
    if (c === "'") {
      inWord = true
      const end = command.indexOf("'", i + 1)
      const body = command.slice(i + 1, end === -1 ? n : end)
      if (body.includes("\n") || body.includes("\r")) {
        opaque = true
      }
      word += body
      if (end === -1) {
        unterminated = true
        i = n
      } else {
        i = end + 1
      }
      continue
    }
    if (c === '"') {
      inWord = true
      i++
      let closed = false
      while (i < n) {
        const d = command.charAt(i)
        if (d === '"') {
          closed = true
          i++
          break
        }
        if (d === "\\" && i + 1 < n) {
          const e = command.charAt(i + 1)
          if (e === "\n" || e === "\r") {
            opaque = true
          } else if (ESCAPABLE_IN_DOUBLE_QUOTES.has(e)) {
            word += e
          } else {
            word += d
            i++
            continue
          }
          i += 2
          continue
        }
        if (d === "$" || d === "`" || d === "\n" || d === "\r") {
          opaque = true
        }
        word += d
        i++
      }
      if (!closed) {
        unterminated = true
      }
      continue
    }
    if (c === "\\") {
      if (i + 1 >= n) {
        inWord = true
        word += c
        opaque = true
        i++
        continue
      }
      const e = command.charAt(i + 1)
      if (e === "\n" || e === "\r") {
        flushSegment()
      } else {
        inWord = true
        word += e
      }
      i += 2
      continue
    }
    if (c === " " || c === "\t") {
      flushWord()
      i++
      continue
    }
    if (SEPARATORS.has(c)) {
      flushSegment()
      i++
      continue
    }
    if (OPAQUE_CHARS.has(c)) {
      opaque = true
    }
    inWord = true
    word += c
    i++
  }
  flushSegment()
  return { segments, unterminated }
}

// Text used only for extra segments when the command has constructs the lexer cannot follow exactly
// (command substitution, newlines inside quotes). Quotes become spaces and every boundary becomes ";",
// so the inner commands surface as separate segments for deny and risk checks. Never used for allow.
const fallbackText = (command: string): string =>
  command
    .split("$(")
    .join(";")
    .split("`")
    .join(";")
    .split(")")
    .join(";")
    .split("\n")
    .join(";")
    .split("\r")
    .join(";")
    .split('"')
    .join(" ")
    .split("'")
    .join(" ")

const needsFallback = (command: string): boolean =>
  command.includes("$(") || command.includes("`") || command.includes("\n") || command.includes("\r")

export const parseShell = (command: string): ShellParse => {
  const primary = lexShell(command)
  const fallback = needsFallback(command) ? lexShell(fallbackText(command)).segments : []
  const extraSegments: ReadonlyArray<ShellSegment> = fallback.map((s) => ({ argv: s.argv, opaque: true }))
  const segments = [...primary.segments, ...extraSegments]
  const compound =
    fallback.length > 0 ||
    primary.segments.length !== 1 ||
    primary.unterminated ||
    (primary.segments[0]?.opaque ?? true)
  return { segments, compound, unterminated: primary.unterminated }
}
