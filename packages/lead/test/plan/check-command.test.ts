import { describe, expect, it } from "vitest"
import { checkCommandOk } from "../../src/plan/check-command.js"

describe("checkCommandOk", () => {
  it.each([
    [["pnpm", "test"]],
    [["pnpm", "lint"]],
    [["pnpm", "typecheck"]],
    [["pnpm", "build"]],
    [["pnpm", "run", "test"]],
    [["npm", "run", "lint"]],
    [["yarn", "build"]],
    [["bun", "test"]],
    [["pnpm", "--filter", "@shoalwork/lead", "test"]],
    [["pnpm", "--filter=@shoalwork/lead", "test"]],
    [["pnpm", "-r", "test"]],
    [["pnpm", "test", "packages/lead/test/a.test.ts"]],
  ])("accepts %j", (argv) => {
    expect(checkCommandOk(argv)).toBe(true)
  })

  it.each([
    [[]],
    [["pnpm"]],
    [["pnpm", "install"]],
    [["pnpm", "exec", "node"]],
    [["pnpm", "dlx", "x"]],
    [["pnpm", "run"]],
    [["pnpm", "run", "start"]],
    [["pnpm", "run", "run", "test"]],
    [["pnpm", "test", "--"]],
    [["pnpm", "-C", "..", "test"]],
    [["pnpm", "--dir", "/tmp", "test"]],
    [["pnpm", "--prefix", "/", "test"]],
    [["pnpm", "--cwd", "/", "test"]],
    [["pnpm", "--config.registry=x", "test"]],
    [["pnpm", "--filter", "../other", "test"]],
    [["pnpm", "--filter", "/abs", "test"]],
    [["pnpm", "--filter", "a/../../b", "test"]],
    [["pnpm", "--filter", "./pkg", "test"]],
    [["pnpm", "--filter"]],
    [["pnpm", "--filter=../x", "test"]],
    [["pnpm", "test", "../outside"]],
    [["pnpm", "test", "/etc/passwd"]],
    [["node", "-e", "1"]],
    [["git", "-c", "core.hooksPath=/tmp", "commit"]],
    [["sh", "-c", "pnpm test"]],
    [["pnpm", "-c", "test"]],
  ])("refuses %j", (argv) => {
    expect(checkCommandOk(argv)).toBe(false)
  })
})
