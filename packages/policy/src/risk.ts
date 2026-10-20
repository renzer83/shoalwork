import { Buffer } from "node:buffer"
import type { Risk, ToolCall } from "@shoalwork/contracts"
import { Schema } from "effect"
import { basename, globMatch } from "./match.js"
import { type CommandNode, expandCommand, gitSubcommandIndex, pmVerbIndex } from "./unwrap.js"

// Risk per tool call (02-architecture §7). Pure: no config, no I/O.
// Unknown tools are "external". Irreversible calls always ask, whatever the rules say.

const RISK_ORDER: ReadonlyArray<Risk> = ["read", "write_local", "external", "irreversible"]

export const maxRisk = (a: Risk, b: Risk): Risk => (RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b) ? a : b)

const READ_TOOLS: ReadonlySet<string> = new Set(["Read", "Glob", "Grep", "WebFetch"])
const WRITE_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write"])
const IRREVERSIBLE_TOOL_PATTERNS: ReadonlyArray<string> = ["stripe.*", "email.send", "deploy.*"]
const MCP_IRREVERSIBLE_WORDS: ReadonlyArray<string> = [
  "stripe",
  "pay",
  "billing",
  "gmail",
  "email",
  "mail",
  "deploy",
  "delete",
  "drop",
]
// Matched on the text of a command or of a non-read, non-write tool input. Word boundaries.
const DESTRUCTIVE_SQL = /\b(drop|truncate)\b/i

// "log" and "show" are not read verbs: they print the content of any file of the history (git show HEAD:.env), which
// the deny rules on the paths cannot catch. They are external (ask) unless a rule of the policy says otherwise.
const READ_GIT_VERBS: ReadonlySet<string> = new Set(["status", "diff", "blame", "shortlog"])
const GIT_OUTPUT_PREFIXES = ["--output", "--ext-diff", "--textconv", "--no-index"]
const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(["npm", "pnpm", "yarn", "bun"])
const PM_WRITE_VERBS: ReadonlySet<string> = new Set([
  "test",
  "run",
  "build",
  "lint",
  "typecheck",
  "install",
  "i",
  "add",
  "ci",
  "list",
  "ls",
  "why",
  "outdated",
])
const CARGO_WRITE_VERBS: ReadonlySet<string> = new Set(["build", "test", "check", "clippy", "fmt", "run"])
const FIND_DESTRUCTIVE: ReadonlySet<string> = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir"])
const INLINE_CODE_FLAGS: ReadonlySet<string> = new Set(["-c", "-e", "-E", "--eval"])

const BASH_INPUT = Schema.Struct({ command: Schema.String })

export const commandOf = (input: unknown): string | undefined =>
  Schema.is(BASH_INPUT)(input) ? input.command : undefined

// Default cap, in UTF-8 bytes, for each string a call carries that the policy reads: the Bash command,
// the resource and the path-like fields. Above it the call is asked at once, never lexed or matched.
export const DEFAULT_MAX_INPUT_BYTES = 16 * 1024

const PATH_LIKE_INPUT = Schema.Struct({
  file_path: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.String),
  pattern: Schema.optionalKey(Schema.String),
  notebook_path: Schema.optionalKey(Schema.String),
  glob: Schema.optionalKey(Schema.String),
})

const sizedFields = (call: ToolCall): ReadonlyArray<string> => {
  const out: string[] = []
  if (call.resource !== undefined) {
    out.push(call.resource)
  }
  if (call.tool === "Bash") {
    const command = commandOf(call.input)
    if (command !== undefined) {
      out.push(command)
    }
  } else if (Schema.is(PATH_LIKE_INPUT)(call.input)) {
    for (const value of [
      call.input.file_path,
      call.input.path,
      call.input.pattern,
      call.input.notebook_path,
      call.input.glob,
    ]) {
      if (value !== undefined) {
        out.push(value)
      }
    }
  }
  return out
}

// Reason text when a field is over the cap, undefined otherwise. Byte length is linear and does not parse.
export const inputTooLarge = (call: ToolCall, maxBytes: number): string | undefined => {
  for (const text of sizedFields(call)) {
    const bytes = Buffer.byteLength(text, "utf8")
    if (bytes > maxBytes) {
      return `input too large: ${bytes} bytes > ${maxBytes}`
    }
  }
  return undefined
}

const textOf = (input: unknown): string | undefined => {
  try {
    return JSON.stringify(input)
  } catch {
    // Unserializable input cannot be inspected for SQL, so the caller classifies it as external (fail closed).
    return undefined
  }
}

const isRecursiveFlag = (word: string): boolean =>
  word === "--recursive" ||
  (word.startsWith("-") && !word.startsWith("--") && (word.includes("r") || word.includes("R")))

// Force, delete and prune forms of git push. Short clusters count when they contain f or d (-f, -uf, -d).
const isDestructivePushArg = (word: string): boolean => {
  if (word.startsWith("--")) {
    return word.startsWith("--force") || word === "--mirror" || word === "--delete" || word === "--prune"
  }
  if (word.startsWith("+") || word.startsWith(":")) {
    return true
  }
  return word.startsWith("-") && (word.includes("f") || word.includes("d"))
}

const gitIrreversible = (argv: ReadonlyArray<string>): boolean => {
  const sub = gitSubcommandIndex(argv)
  if (sub === -1) {
    return false
  }
  const verb = argv[sub] ?? ""
  const args = argv.slice(sub + 1)
  if (verb === "push") {
    return args.some(isDestructivePushArg)
  }
  if (verb === "clean") {
    return args.some((a) => a === "--force" || (a.startsWith("-") && !a.startsWith("--") && a.includes("f")))
  }
  if (verb === "reset") {
    return args.includes("--hard")
  }
  if (verb === "checkout") {
    return args.includes("--")
  }
  if (verb === "restore") {
    return args.some((a) => a === "--worktree" || a === "-W" || a === "." || a === ":/")
  }
  if (verb === "branch") {
    return args.includes("-D")
  }
  if (verb === "stash") {
    return args.includes("clear") || args.includes("drop")
  }
  return verb.startsWith("filter-")
}

// Irreversible by head word (basename: /bin/rm -rf is rm -rf).
const isIrreversibleArgv = (argv: ReadonlyArray<string>): boolean => {
  const head = argv[0]
  if (head === undefined) {
    return false
  }
  const args = argv.slice(1)
  const name = basename(head)
  if (name === "rm") {
    return args.some((a) => isRecursiveFlag(a) || a === "--no-preserve-root")
  }
  if (name === "docker") {
    return args.includes("prune")
  }
  if (name === "find") {
    return args.some((a) => FIND_DESTRUCTIVE.has(a))
  }
  if (name === "git") {
    return gitIrreversible(argv)
  }
  if (name.startsWith("python") || name === "node" || name === "ruby" || name === "perl") {
    return args.some((a) => INLINE_CODE_FLAGS.has(a) || a.startsWith("--eval"))
  }
  return false
}

const verbOf = (argv: ReadonlyArray<string>): string | undefined => {
  const at = pmVerbIndex(argv)
  return at === undefined ? undefined : argv[at]
}

// Trusted nodes only (bare head word). Whitelists: anything not listed is external.
const classifyTrusted = (argv: ReadonlyArray<string>): Risk => {
  const head = argv[0]
  if (head === "git") {
    if (gitSubcommandIndex(argv) !== 1) {
      // Global options (-c can set core.pager or aliases that run commands) are never read or write_local.
      return "external"
    }
    const verb = argv[1] ?? ""
    const args = argv.slice(2)
    if (READ_GIT_VERBS.has(verb)) {
      const outputs = args.some((a) => a === "-o" || GIT_OUTPUT_PREFIXES.some((p) => a.startsWith(p)))
      return outputs ? "external" : "read"
    }
    return verb === "add" || verb === "commit" ? "write_local" : "external"
  }
  if (head !== undefined && PACKAGE_MANAGERS.has(head)) {
    if (argv.slice(1).some((a) => a === "-g" || a === "--global")) {
      return "external"
    }
    const verb = verbOf(argv)
    return verb !== undefined && PM_WRITE_VERBS.has(verb) ? "write_local" : "external"
  }
  if (head === "cargo") {
    const verb = verbOf(argv)
    return verb !== undefined && CARGO_WRITE_VERBS.has(verb) ? "write_local" : "external"
  }
  return "external"
}

const nodeRisk = (node: CommandNode): Risk => {
  if (node.overDepth || isIrreversibleArgv(node.argv)) {
    return "irreversible"
  }
  if (node.argv.length === 0) {
    return "external"
  }
  if (node.wrapper) {
    return node.trusted ? "read" : "external"
  }
  return node.trusted ? classifyTrusted(node.argv) : "external"
}

const riskOfBash = (command: string | undefined): Risk => {
  if (command === undefined) {
    return "external"
  }
  if (DESTRUCTIVE_SQL.test(command)) {
    return "irreversible"
  }
  const expansion = expandCommand(command)
  if (expansion.nodes.length === 0) {
    return "external"
  }
  let worst: Risk = "read"
  for (const node of expansion.nodes) {
    worst = maxRisk(worst, nodeRisk(node))
  }
  return expansion.unterminated ? maxRisk(worst, "external") : worst
}

const isMcpIrreversible = (tool: string): boolean =>
  tool.startsWith("mcp__") && MCP_IRREVERSIBLE_WORDS.some((w) => tool.toLowerCase().includes(w))

export const riskOf = (call: ToolCall, maxBytes = DEFAULT_MAX_INPUT_BYTES): Risk => {
  if (inputTooLarge(call, maxBytes) !== undefined) {
    return "irreversible"
  }
  if (IRREVERSIBLE_TOOL_PATTERNS.some((pattern) => globMatch(pattern, call.tool, false))) {
    return "irreversible"
  }
  if (isMcpIrreversible(call.tool)) {
    return "irreversible"
  }
  if (call.tool === "Bash") {
    return riskOfBash(commandOf(call.input))
  }
  if (READ_TOOLS.has(call.tool)) {
    return "read"
  }
  if (WRITE_TOOLS.has(call.tool)) {
    return "write_local"
  }
  const text = textOf(call.input)
  if (text === undefined) {
    return "external"
  }
  return DESTRUCTIVE_SQL.test(text) ? "irreversible" : "external"
}

// Calls the loader uses to reject an allow rule that could cover an irreversible action. Each one is irreversible.
// Remote runners: never allowed (compound), so decide asks. Not irreversible, so not in the load check.
export const REMOTE_EXEC_PROBES: ReadonlyArray<ToolCall> = [
  { tool: "Bash", input: { command: "pnpm dlx x" } },
  { tool: "Bash", input: { command: "npm x rm -rf /" } },
  { tool: "Bash", input: { command: "npx x" } },
]

export const IRREVERSIBLE_PROBES: ReadonlyArray<ToolCall> = [
  { tool: "Bash", input: { command: "rm -rf /" } },
  { tool: "Bash", input: { command: "rm -r -f /" } },
  { tool: "Bash", input: { command: "rm --no-preserve-root /" } },
  { tool: "Bash", input: { command: "git push --force origin main" } },
  { tool: "Bash", input: { command: "git push origin :main" } },
  { tool: "Bash", input: { command: "docker system prune -a" } },
  { tool: "Bash", input: { command: 'psql -c "DROP TABLE users"' } },
  { tool: "Bash", input: { command: "env rm -rf /" } },
  { tool: "Bash", input: { command: "command rm -rf /" } },
  { tool: "Bash", input: { command: "exec rm -rf /" } },
  { tool: "Bash", input: { command: "sudo rm -rf /" } },
  { tool: "Bash", input: { command: "doas rm -rf /" } },
  { tool: "Bash", input: { command: "nohup rm -rf /" } },
  { tool: "Bash", input: { command: "timeout 5 rm -rf /" } },
  { tool: "Bash", input: { command: "nice -n 5 rm -rf /" } },
  { tool: "Bash", input: { command: "xargs rm -rf" } },
  { tool: "Bash", input: { command: "time rm -rf /" } },
  { tool: "Bash", input: { command: "stdbuf -oL rm -rf /" } },
  { tool: "Bash", input: { command: "bash -c 'rm -rf /'" } },
  { tool: "Bash", input: { command: 'sh -c "git push --force"' } },
  { tool: "Bash", input: { command: "eval 'rm -rf /'" } },
  { tool: "Bash", input: { command: "python3 -c 'import os'" } },
  { tool: "Bash", input: { command: "node -e 'process.exit(0)'" } },
  { tool: "Bash", input: { command: "find . -delete" } },
  { tool: "Bash", input: { command: "pnpm exec rm -rf /" } },
  { tool: "Bash", input: { command: "npm exec -- rm -rf /" } },
  { tool: "Bash", input: { command: "pnpm exec bash -c 'rm -rf /'" } },
  { tool: "Bash", input: { command: "git clean -fd" } },
  { tool: "Bash", input: { command: "git reset --hard" } },
  { tool: "Bash", input: { command: "git checkout -- ." } },
  { tool: "Bash", input: { command: "git restore ." } },
  { tool: "Bash", input: { command: "git branch -D feature" } },
  { tool: "Bash", input: { command: "git stash clear" } },
  { tool: "Bash", input: { command: "git filter-branch --all" } },
  { tool: "stripe.charge", input: {} },
  { tool: "email.send", input: {} },
  { tool: "deploy.production", input: {} },
  { tool: "mcp__stripe__charge", input: {} },
  { tool: "mcp__gmail__send", input: {}, resource: "x" },
]
