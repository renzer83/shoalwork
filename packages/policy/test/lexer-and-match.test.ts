import { describe, expect, it } from "vitest"
import { argvMatch, globMatch, parseArgvPattern, parseToolPattern } from "../src/match.js"
import { parseShell } from "../src/shell.js"

describe("shell lexer", () => {
  it("reads one simple command", () => {
    const parsed = parseShell("git status")
    expect(parsed.compound).toBe(false)
    expect(parsed.segments).toEqual([{ argv: ["git", "status"], opaque: false }])
  })

  it("splits on ; && || | and newlines", () => {
    for (const command of [
      "git status; rm x",
      "git status && rm x",
      "git status || rm x",
      "git status | rm x",
      "git status\nrm x",
    ]) {
      const parsed = parseShell(command)
      expect(parsed.compound).toBe(true)
      expect(parsed.segments.map((s) => s.argv[0])).toEqual(expect.arrayContaining(["git", "rm"]))
    }
  })

  it("removes quotes so a quoted flag is a plain word", () => {
    expect(parseShell('git push "--force" origin').segments[0]?.argv).toEqual([
      "git",
      "push",
      "--force",
      "origin",
    ])
    expect(parseShell("git push '--force'").segments[0]?.argv).toEqual(["git", "push", "--force"])
  })

  it("keeps separators inside quotes as text", () => {
    const parsed = parseShell('git commit -m "feat; x"')
    expect(parsed.compound).toBe(false)
    expect(parsed.segments[0]?.argv).toEqual(["git", "commit", "-m", "feat; x"])
  })

  it("marks unquoted expansions, globs, env prefixes and unterminated quotes", () => {
    expect(parseShell("echo $HOME").compound).toBe(true)
    expect(parseShell("git status *").compound).toBe(true)
    expect(parseShell("FOO=1 git status").compound).toBe(true)
    expect(parseShell('git log "abc').unterminated).toBe(true)
    expect(parseShell("git status\\").compound).toBe(true)
  })

  it("treats command substitution as compound and exposes the inner command", () => {
    const parsed = parseShell("echo $(rm -rf /)")
    expect(parsed.compound).toBe(true)
    expect(parsed.segments.some((s) => s.argv[0] === "rm")).toBe(true)
  })

  it("exposes a command hidden in double quotes via command substitution", () => {
    const parsed = parseShell('echo "$(rm -rf /)"')
    expect(parsed.compound).toBe(true)
    expect(parsed.segments.some((s) => s.argv[0] === "rm")).toBe(true)
  })
})

describe("glob and argv matching", () => {
  it("matches word globs and crosses slashes in word mode", () => {
    expect(globMatch("a*", "a/b", false)).toBe(true)
    expect(globMatch("a?c", "abc", false)).toBe(true)
    expect(globMatch("--force*", "--force-with-lease", false)).toBe(true)
  })

  it("keeps * and ? inside one path segment and lets ** cross them", () => {
    expect(globMatch("src/*.ts", "src/a/b.ts", true)).toBe(false)
    expect(globMatch("src/**/*.ts", "src/a/b.ts", true)).toBe(true)
    expect(globMatch("**/.env*", ".env", true)).toBe(true)
    expect(globMatch("**/.env*", "apps/web/.env.local", true)).toBe(true)
    expect(globMatch("*.ts", "a/b.ts", true)).toBe(false)
    expect(globMatch("a?c", "a/c", true)).toBe(false)
  })

  it("matches argv word by word, with * for zero or more words", () => {
    expect(argvMatch(["git", "push", "*"], ["git", "push"])).toBe(true)
    expect(argvMatch(["git", "push", "*"], ["git", "push", "--force", "origin"])).toBe(true)
    expect(argvMatch(["git", "push", "*", "--force*", "*"], ["git", "push", "--force"])).toBe(true)
    expect(argvMatch(["git", "push", "*"], ["git", "status"])).toBe(false)
    expect(argvMatch(["rm", "*r*", "/"], ["rm", "-rf", "/"])).toBe(true)
    expect(argvMatch(["git", "push"], ["git", "pushx"])).toBe(false)
  })

  it("parses tool patterns and rejects malformed ones", () => {
    expect(parseToolPattern("Bash(git push *)")).toEqual({ name: "Bash", spec: "git push *" })
    expect(parseToolPattern("Read")).toEqual({ name: "Read", spec: undefined })
    expect(parseToolPattern("mcp__*")).toEqual({ name: "mcp__*", spec: undefined })
    expect(parseToolPattern("Bash(git")).toBeUndefined()
    expect(parseToolPattern("Bash()")).toBeUndefined()
    expect(parseToolPattern("mcp__*(x)")).toBeUndefined()
    expect(parseToolPattern("")).toBeUndefined()
  })

  it("refuses shell syntax in Bash patterns", () => {
    expect(parseArgvPattern("git push *")).toEqual(["git", "push", "*"])
    expect(parseArgvPattern("git push; rm -rf *")).toBeUndefined()
    expect(parseArgvPattern("git $(rm)")).toBeUndefined()
    expect(parseArgvPattern("   ")).toBeUndefined()
  })
})
