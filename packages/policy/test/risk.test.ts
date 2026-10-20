import type { Risk, ToolCall } from "@shoalwork/contracts"
import { describe, expect, it } from "vitest"
import { IRREVERSIBLE_PROBES, riskOf } from "../src/risk.js"

const bash = (command: string): ToolCall => ({ tool: "Bash", input: { command } })

describe("riskOf: read and local writes", () => {
  const cases: ReadonlyArray<readonly [string, ToolCall, Risk]> = [
    ["Read", { tool: "Read", input: { file_path: "a.ts" } }, "read"],
    ["Glob", { tool: "Glob", input: { pattern: "**/*.ts" } }, "read"],
    ["Grep", { tool: "Grep", input: { pattern: "x" } }, "read"],
    ["WebFetch", { tool: "WebFetch", input: { url: "https://example.com" } }, "read"],
    ["Edit", { tool: "Edit", input: { file_path: "a.ts" } }, "write_local"],
    ["Write", { tool: "Write", input: { file_path: "a.ts", content: "x" } }, "write_local"],
    ["git status", bash("git status"), "read"],
    ["git diff", bash("git diff --stat"), "read"],
    ["git add", bash("git add packages/policy/src/risk.ts"), "write_local"],
    ["git commit", bash('git commit -m "feat: x"'), "write_local"],
    ["pnpm test", bash("pnpm -r test"), "write_local"],
    ["npm install", bash("npm install"), "write_local"],
    ["cargo build", bash("cargo build --release"), "write_local"],
    ["git -C path status is not read", bash("git -C /repo status"), "external"],
    ["git -c option is not read", bash("git -c core.pager=x log"), "external"],
    ["./git is not git", bash("./git status"), "external"],
    ["unknown Bash command", bash("curl https://example.com"), "external"],
    ["Bash without a command", { tool: "Bash", input: { cmd: "git status" } }, "external"],
  ]
  for (const [name, call, expected] of cases) {
    it(`classifies ${name} as ${expected}`, () => {
      expect(riskOf(call)).toBe(expected)
    })
  }
})

describe("riskOf: external", () => {
  const cases: ReadonlyArray<readonly [string, ToolCall]> = [
    ["git push", bash("git push origin main")],
    ["git log", bash("git log --oneline")],
    ["git show", bash("git show HEAD:src/a.ts")],
    ["npm publish", bash("npm publish")],
    ["pnpm dlx", bash("pnpm dlx some-tool")],
    ["mcp tool", { tool: "mcp__github__create_issue", input: { title: "x" } }],
    ["unknown tool", { tool: "Foo", input: {} }],
    ["compound with an unknown part", bash("git status; curl x")],
    ["env prefix hides the command", bash("GIT_SSH_COMMAND=x git push origin main")],
    ["unquoted glob may expand", bash("git status *")],
    ["unterminated quote", bash('git log --grep="x')],
  ]
  for (const [name, call] of cases) {
    it(`classifies ${name} as external`, () => {
      expect(riskOf(call)).toBe("external")
    })
  }
})

describe("riskOf: irreversible", () => {
  const cases: ReadonlyArray<readonly [string, ToolCall]> = [
    ["rm -rf", bash("rm -rf ./build")],
    ["rm -fr", bash("rm -fr ./build")],
    ["rm --recursive", bash("rm --recursive ./build")],
    ["absolute path through /bin/rm", bash("/bin/rm -rf ./build")],
    ["git push --force", bash("git push --force origin main")],
    ["git push --force-with-lease", bash("git push --force-with-lease origin main")],
    ["git push -f", bash("git push -f origin main")],
    ["git push -uf", bash("git push -uf origin main")],
    ["git push with a + refspec", bash("git push origin +main")],
    ["git push delete refspec", bash("git push origin :main")],
    ["git push --delete", bash("git push --delete origin feature")],
    ["force push after global options", bash("git -C /repo push --force origin main")],
    ["force push in a quoted flag", bash('git push "--force" origin main')],
    ["force push after an && segment", bash("git status && git push --force")],
    ["docker prune", bash("docker system prune -a")],
    ["DROP in a command", bash('psql -c "DROP TABLE users"')],
    ["TRUNCATE in a command", bash("sqlite3 db.sqlite 'TRUNCATE t'")],
    ["stripe tool", { tool: "stripe.charge", input: {} }],
    ["email send tool", { tool: "email.send", input: {} }],
    ["deploy tool", { tool: "deploy.production", input: {} }],
    ["DROP in an mcp tool input", { tool: "mcp__db__query", input: { sql: "DROP TABLE users" } }],
  ]
  for (const [name, call] of cases) {
    it(`classifies ${name} as irreversible`, () => {
      expect(riskOf(call)).toBe("irreversible")
    })
  }

  it("keeps Edit and Read content out of the SQL check", () => {
    expect(riskOf({ tool: "Edit", input: { file_path: "migration.sql", content: "DROP TABLE x" } })).toBe(
      "write_local",
    )
    expect(riskOf({ tool: "Read", input: { file_path: "migration.sql" } })).toBe("read")
  })

  it("keeps every irreversible probe irreversible", () => {
    for (const probe of IRREVERSIBLE_PROBES) {
      expect(riskOf(probe)).toBe("irreversible")
    }
  })
})
