import { it } from "@effect/vitest"
import type { PolicyEffect, ToolCall } from "@shoalwork/contracts"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { Policy } from "../src/index.js"
import { BOT, baseLayer } from "./support.js"

// T-057: the allows the base policy names must not loosen anything. Each row is what the policy decided before the
// allows; the asks added for variants (git diff of paths, pnpm config and directory flags) tighten that, and are listed
// as "ask" here on purpose. "git log" and "git show" are not read verbs (T-057): they print the content of any file of
// the history, so they ask.
const bash = (command: string): ToolCall => ({ tool: "Bash", input: { command } })
const ROWS: ReadonlyArray<readonly [ToolCall, PolicyEffect]> = [
  [{ tool: "Read", input: { file_path: "src/a.ts" } }, "allow"],
  [{ tool: "Read", input: { file_path: ".env" } }, "deny"],
  [{ tool: "Read", input: { file_path: "/home/x/.ssh/id_rsa" } }, "deny"],
  [{ tool: "Grep", input: { pattern: "foo", path: "src" } }, "allow"],
  [{ tool: "Glob", input: { pattern: "src/**" } }, "allow"],
  [{ tool: "Edit", input: { file_path: "src/a.ts" } }, "allow"],
  [{ tool: "Edit", input: { file_path: ".env" } }, "deny"],
  [{ tool: "Write", input: { file_path: "/etc/hosts" } }, "deny"],
  [bash("git status"), "allow"],
  [bash("git status --porcelain"), "allow"],
  [bash("git diff HEAD"), "allow"],
  [bash("git diff -o /tmp/x"), "ask"],
  [bash("git diff --output=/tmp/x"), "ask"],
  [bash("git diff --no-index a b"), "ask"],
  [bash("git diff --ext-diff HEAD"), "ask"],
  [bash("git diff --textconv HEAD"), "ask"],
  [bash("git push origin main"), "ask"],
  [bash("git push --force origin main"), "ask"],
  [bash("pnpm test"), "allow"],
  [bash("pnpm test --filter x"), "allow"],
  [bash("pnpm build"), "allow"],
  [bash("pnpm lint"), "allow"],
  [bash("pnpm typecheck"), "allow"],
  [bash("npm test"), "allow"],
  [bash("pnpm test -g"), "ask"],
  [bash("pnpm --global install x"), "ask"],
  [bash("pnpm test && rm -rf /"), "deny"], // the deny on rm of the root was already there,
  [bash("pnpm exec rm -rf /"), "deny"],
  [bash("pnpm dlx x"), "ask"],
  [bash("pnpm test DROP TABLE users"), "ask"],
  [bash("git diff /etc/hosts /etc/shells"), "ask"],
  [bash("git diff -- .env"), "ask"],
  [bash("git diff -O/home/x/.ssh/id_rsa"), "ask"],
  [bash("git diff ../secret HEAD"), "ask"],
  [bash("git diff HEAD -- src/a.ts"), "allow"],
  [bash("git show HEAD:.env"), "ask"],
  [bash("git show HEAD:src/a.ts"), "ask"],
  [bash("git log --oneline -5"), "ask"],
  [bash("pnpm test --config.x=y"), "ask"],
  [bash("pnpm test --userconfig /tmp/rc"), "ask"],
  [bash("pnpm -C /other test"), "ask"],
  [bash("pnpm test --dir /other"), "ask"],
  [bash("pnpm test --prefix /other"), "ask"],
  [bash("pnpm test --global x"), "ask"],
]

describe("base policy allows (T-057) do not loosen", () => {
  it.effect("decides every probe as the policy did before the allows", () =>
    Effect.gen(function* () {
      const policy = yield* Policy
      const mismatches: Array<string> = []
      for (const [call, expected] of ROWS) {
        const decision = yield* policy.evaluate(BOT, call)
        if (decision.effect !== expected) {
          mismatches.push(`${JSON.stringify(call)} -> ${decision.effect}, expected ${expected}`)
        }
      }
      expect(mismatches).toEqual([])
    }).pipe(Effect.provide(baseLayer)),
  )
})
