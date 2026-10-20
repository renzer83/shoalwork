import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { it } from "@effect/vitest"
import { spawnProcess, Tank, type TankShape } from "@shoalwork/tank"
import { Effect, Stream } from "effect"
import { describe, expect } from "vitest"
import { makeAcp } from "../../src/acp/index.js"
import { ctx, fakePolicy, ID, kinds, task } from "./harness.js"

const SCRIPT = fileURLToPath(new URL("./real-agent.mjs", import.meta.url))
const unused = () => Effect.die("not used by the ACP executor")
const tank: TankShape = {
  mode: "local",
  prepare: unused,
  exec: unused,
  spawnStream: (spawnCtx, cmd) => spawnProcess(cmd, { cwd: tmpdir(), env: spawnCtx.env }),
  readFile: unused,
  writeFile: unused,
  writeHomeFile: unused,
  worktrees: unused,
  removeWorktree: unused,
  release: unused,
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// A real child process over real pipes: handshake, prompt, and the whole process group gone when the run ends.
const runReal = (mode: string, allow: boolean) =>
  Effect.gen(function* () {
    const dir = mkdtempSync(join(tmpdir(), "acp-real-"))
    const pidFile = join(dir, "grandchild.pid")
    const executor = makeAcp({
      id: ID,
      bin: process.execPath,
      args: [SCRIPT, pidFile, mode],
      policy: fakePolicy({ Bash: allow ? "allow" : "ask" }).policy,
      quotaWindowSeconds: 3600,
      quotaSoftLimitTokens: 1_000_000,
    })
    const events = yield* Stream.runCollect(
      executor.run(task(), { ...ctx, env: { PATH: process.env.PATH ?? "" } }),
    ).pipe(Effect.scoped, Effect.provideService(Tank, tank))
    const grandchild = Number.parseInt(readFileSync(pidFile, "utf8"), 10)
    rmSync(dir, { recursive: true, force: true })
    return { events, grandchild }
  })

describe("acp over a real process", () => {
  it.live("runs a prompt through stdio and leaves no process behind", () =>
    Effect.gen(function* () {
      const { events, grandchild } = yield* runReal("plain", true)
      expect(kinds(events)).toEqual(["started", "text", "done"])
      expect(events.at(-1)).toMatchObject({ kind: "done", result: "real-pong" })
      expect(alive(grandchild)).toBe(false)
    }),
  )

  it.live("an ask ends the run at approval_needed and kills the whole process group", () =>
    Effect.gen(function* () {
      const { events, grandchild } = yield* runReal("ask", false)
      expect(kinds(events)).toEqual(["started", "text", "approval_needed"])
      expect(events.at(-1)).toMatchObject({ action: { tool: "Bash", input: { command: "make deploy" } } })
      expect(alive(grandchild)).toBe(false)
    }),
  )
})
