import { basename } from "./match.js"
import { isAssignment, parseShell, type ShellSegment } from "./shell.js"

// Wrappers (env, sudo, timeout, xargs, pnpm exec, ...) and shells (bash -c, eval) run another command. Each one is
// peeled off so the inner command is classified and matched as well. Depth is bounded: past the limit the node is
// irreversible and never allowed. Remote runners (pnpm dlx, npm x) are never allowed either.
export const MAX_UNWRAP_DEPTH = 4

// Heads an allow rule may not name: they run another command or escalate. An allow on one is a load error.
export const WRAPPER_HEADS: ReadonlyArray<string> = [
  "env",
  "command",
  "builtin",
  "exec",
  "nohup",
  "time",
  "setsid",
  "nice",
  "timeout",
  "stdbuf",
  "sudo",
  "doas",
  "xargs",
  "eval",
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "busybox",
  "chroot",
  "flock",
  "ionice",
  "su",
  "ssh",
  "script",
  "watch",
  "parallel",
  "caffeinate",
  "arch",
  "doas",
  "pkexec",
]

export interface CommandNode {
  readonly argv: ReadonlyArray<string>
  // Bare head word (no "/") reached only through bare wrappers. Only trusted nodes may be read or write_local.
  readonly trusted: boolean
  // The node runs an inner command, which is a node of its own. Neutral for risk.
  readonly wrapper: boolean
  readonly overDepth: boolean
}

export interface Expansion {
  // Top-level simple commands as parsed (used for literal allow matching).
  readonly outer: ReadonlyArray<ShellSegment>
  // Every command that may run: top-level and inner, in order.
  readonly nodes: ReadonlyArray<CommandNode>
  // Compound, unparseable, wrapped or remote: never allowed by a rule or by default.
  readonly compound: boolean
  readonly unterminated: boolean
}

type Inner =
  | { readonly kind: "none" }
  | { readonly kind: "argv"; readonly argv: ReadonlyArray<string> }
  | { readonly kind: "script"; readonly script: string }
  | { readonly kind: "opaque" }
  | { readonly kind: "remote" }

const SIMPLE_WRAPPERS: ReadonlySet<string> = new Set([
  "command",
  "builtin",
  "exec",
  "nohup",
  "time",
  "setsid",
])
const SHELLS: ReadonlySet<string> = new Set(["bash", "sh", "zsh", "dash", "ksh"])
const SHELL_VALUE_OPTIONS: ReadonlySet<string> = new Set(["-o", "-O", "--rcfile", "--init-file"])
const SHELL_KEYWORDS: ReadonlySet<string> = new Set([
  "if",
  "then",
  "do",
  "else",
  "elif",
  "while",
  "until",
  "!",
])
const SUDO_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-u",
  "-g",
  "-C",
  "-D",
  "-h",
  "-p",
  "-r",
  "-t",
  "-T",
  "-U",
])
const XARGS_VALUE_FLAGS: ReadonlySet<string> = new Set(["-I", "-n", "-P", "-L", "-d", "-E", "-s", "-a"])
const GIT_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
])
const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(["npm", "pnpm", "yarn", "bun"])
const PM_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--filter",
  "-F",
  "--workspace",
  "-w",
  "--prefix",
  "-C",
  "--dir",
  "--manifest-path",
  "-p",
  "--package",
  "--target",
  "--config",
])
const PM_REMOTE_VERBS: ReadonlySet<string> = new Set(["x", "dlx", "explore"])

const isOption = (word: string | undefined): boolean => (word?.startsWith("-") ?? false) && word !== "-"

// Index of the first word after leading options; options in valueFlags take the next word too.
const skipOptions = (argv: ReadonlyArray<string>, start: number, valueFlags: ReadonlySet<string>): number => {
  let i = start
  while (i < argv.length && isOption(argv[i])) {
    i += valueFlags.has(argv[i] ?? "") ? 2 : 1
  }
  return i
}

// Index of the package manager verb (first non-option word, skipping values of options that take one).
export const pmVerbIndex = (argv: ReadonlyArray<string>): number | undefined => {
  for (let i = 1; i < argv.length; i++) {
    const word = argv[i] ?? ""
    if (PM_VALUE_FLAGS.has(word)) {
      i++
      continue
    }
    if (!word.startsWith("-")) {
      return i
    }
  }
  return undefined
}

const packageManagerInner = (argv: ReadonlyArray<string>): Inner | undefined => {
  const at = pmVerbIndex(argv)
  if (at === undefined) {
    return undefined
  }
  const verb = argv[at]
  if (verb === "exec") {
    const start = argv[at + 1] === "--" ? at + 2 : at + 1
    return { kind: "argv", argv: argv.slice(start) }
  }
  return verb !== undefined && PM_REMOTE_VERBS.has(verb) ? { kind: "remote" } : undefined
}

const innerOf = (name: string, argv: ReadonlyArray<string>): Inner => {
  const from = (i: number): Inner => ({ kind: "argv", argv: argv.slice(i) })
  if (SIMPLE_WRAPPERS.has(name)) {
    return from(skipOptions(argv, 1, new Set(["-a"])))
  }
  if (name === "env") {
    let i = 1
    while (i < argv.length) {
      const word = argv[i] ?? ""
      if (word === "-S" || word.startsWith("--split-string")) {
        return { kind: "opaque" }
      }
      if (word === "-u" || word === "-C") {
        i += 2
      } else if (isOption(word) || isAssignment(word)) {
        i += 1
      } else {
        break
      }
    }
    return from(i)
  }
  if (name === "nice") {
    return from(skipOptions(argv, 1, new Set(["-n"])))
  }
  if (name === "timeout") {
    // The duration word follows the options.
    return from(skipOptions(argv, 1, new Set(["-s", "-k", "--signal", "--kill-after"])) + 1)
  }
  if (name === "stdbuf") {
    return from(skipOptions(argv, 1, new Set(["-i", "-o", "-e"])))
  }
  if (name === "sudo" || name === "doas") {
    return from(skipOptions(argv, 1, SUDO_VALUE_FLAGS))
  }
  if (name === "xargs") {
    return from(skipOptions(argv, 1, XARGS_VALUE_FLAGS))
  }
  if (name === "eval") {
    return { kind: "script", script: argv.slice(1).join(" ") }
  }
  if (SHELLS.has(name)) {
    for (let i = 1; i < argv.length; i++) {
      const word = argv[i] ?? ""
      if (SHELL_VALUE_OPTIONS.has(word)) {
        i++
        continue
      }
      if (!isOption(word)) {
        // A script file or stdin: its content is not visible here.
        return { kind: "none" }
      }
      if (!word.startsWith("--") && word.includes("c")) {
        // The script is the first word after -c that is not an option.
        const script = argv.slice(i + 1).find((w) => !isOption(w))
        return script === undefined ? { kind: "opaque" } : { kind: "script", script }
      }
    }
    return { kind: "none" }
  }
  if (PACKAGE_MANAGERS.has(name)) {
    return packageManagerInner(argv) ?? { kind: "none" }
  }
  return { kind: "none" }
}

const opaqueNode = (): CommandNode => ({ argv: [], trusted: false, wrapper: false, overDepth: false })

// Shell reserved words in front of a command ("if rm …", "do git push", "! git …") are not the command.
const stripKeywords = (argv: ReadonlyArray<string>): ReadonlyArray<string> => {
  let i = 0
  while (i < argv.length && SHELL_KEYWORDS.has(argv[i] ?? "")) {
    i++
  }
  return argv.slice(i)
}

const expandArgv = (
  argvIn: ReadonlyArray<string>,
  trusted: boolean,
  depth: number,
  nodes: CommandNode[],
  flags: { wrapped: boolean; unterminated: boolean },
): void => {
  const argv = stripKeywords(argvIn)
  if (argv.length === 0) {
    nodes.push(opaqueNode())
    return
  }
  const head = argv[0] ?? ""
  const nodeTrusted = trusted && !head.includes("/")
  if (depth > MAX_UNWRAP_DEPTH) {
    flags.wrapped = true
    nodes.push({ argv, trusted: false, wrapper: false, overDepth: true })
    return
  }
  const inner = innerOf(basename(head), argv)
  if (inner.kind === "none") {
    nodes.push({ argv, trusted: nodeTrusted, wrapper: false, overDepth: false })
    return
  }
  flags.wrapped = true
  if (inner.kind === "remote") {
    // Runs a package fetched from a registry: a leaf (external), never allowed.
    nodes.push({ argv, trusted: nodeTrusted, wrapper: false, overDepth: false })
    return
  }
  nodes.push({ argv, trusted: nodeTrusted, wrapper: true, overDepth: false })
  if (inner.kind === "opaque") {
    nodes.push(opaqueNode())
    return
  }
  if (inner.kind === "argv") {
    if (inner.argv.length > 0) {
      expandArgv(inner.argv, nodeTrusted, depth + 1, nodes, flags)
    }
    return
  }
  if (inner.kind === "script") {
    const parsed = parseShell(inner.script)
    if (parsed.unterminated) {
      flags.unterminated = true
    }
    for (const segment of parsed.segments) {
      if (segment.argv.length === 0) {
        nodes.push(opaqueNode())
      } else {
        expandArgv(segment.argv, nodeTrusted && !segment.opaque, depth + 1, nodes, flags)
      }
    }
  }
}

export const expandCommand = (command: string): Expansion => {
  const parsed = parseShell(command)
  const nodes: CommandNode[] = []
  const flags = { wrapped: false, unterminated: parsed.unterminated }
  for (const segment of parsed.segments) {
    if (segment.argv.length === 0) {
      nodes.push(opaqueNode())
    } else {
      expandArgv(segment.argv, !segment.opaque, 0, nodes, flags)
    }
  }
  return {
    outer: parsed.segments,
    nodes,
    compound: parsed.compound || flags.wrapped || flags.unterminated,
    unterminated: flags.unterminated,
  }
}

// Git global options (-C x, -c k=v, --git-dir x, …) come before the subcommand. -1 when there is none.
export const gitSubcommandIndex = (argv: ReadonlyArray<string>): number => {
  let i = 1
  while (i < argv.length) {
    const word = argv[i]
    if (word === undefined) {
      break
    }
    if (GIT_VALUE_OPTIONS.has(word)) {
      i += 2
    } else if (word.startsWith("-")) {
      i += 1
    } else {
      return i
    }
  }
  return -1
}

// Matching form: basename head, and git global options removed so "git -C . push" matches "git push".
export const normalizedArgv = (argv: ReadonlyArray<string>): ReadonlyArray<string> => {
  const head = argv[0]
  if (head === undefined) {
    return argv
  }
  const name = basename(head)
  if (name !== "git") {
    return [name, ...argv.slice(1)]
  }
  const sub = gitSubcommandIndex(argv)
  return sub === -1 ? [name, ...argv.slice(1)] : ["git", ...argv.slice(sub)]
}
