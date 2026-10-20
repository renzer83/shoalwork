import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as acp from "@agentclientprotocol/sdk"
import { it } from "@effect/vitest"
import { makeTankLocal, type TankContext } from "@shoalwork/tank"
import { Effect } from "effect"
import { afterAll, beforeAll, describe, expect } from "vitest"
import { FS_MAX_BYTES, type FsDeps, readTextFile, writeTextFile } from "../../src/acp/fs.js"
import type { AcpPolicy } from "../../src/acp/index.js"
import type { PromptCall } from "./fake-agent.js"
import { BOT, fakePolicy, runAgent, task, withRealPolicy } from "./harness.js"

let root: string
let cwd: string
let outside: string

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "acp-fs-")))
  cwd = join(root, "work")
  outside = join(root, "outside")
  mkdirSync(cwd)
  mkdirSync(outside)
  writeFileSync(join(cwd, "a.txt"), "one\ntwo\nthree\n")
  writeFileSync(join(outside, "secret.txt"), "top secret")
  symlinkSync(outside, join(cwd, "link"))
  symlinkSync(join(outside, "secret.txt"), join(cwd, "peek.txt"))
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

const tank = makeTankLocal({ root: join(tmpdir(), "acp-fs-tank-unused"), baseEnv: {} })
const ctxIn = (): TankContext => ({
  botId: BOT,
  botName: "bot-a",
  cwd,
  home: join(root, "home"),
  env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
})
const allowAll = fakePolicy({ Read: "allow", Write: "allow" }).policy
const deps = (policy: AcpPolicy = allowAll, readonly = false): FsDeps => ({
  tank,
  ctx: ctxIn(),
  botId: BOT,
  policy,
  readonly,
})

const failureOf = <A>(effect: Effect.Effect<A, acp.RequestError>) =>
  Effect.flip(effect).pipe(Effect.map((error) => error.message))

describe("acp fs", () => {
  it.effect("reads a file inside the cwd, with line and limit", () =>
    Effect.gen(function* () {
      const whole = yield* readTextFile(deps(), { sessionId: "s", path: join(cwd, "a.txt") })
      expect(whole.content).toBe("one\ntwo\nthree\n")
      const part = yield* readTextFile(deps(), {
        sessionId: "s",
        path: join(cwd, "a.txt"),
        line: 2,
        limit: 1,
      })
      expect(part.content).toBe("two")
    }),
  )

  it.effect("writes a new file inside the cwd", () =>
    Effect.gen(function* () {
      yield* writeTextFile(deps(), { sessionId: "s", path: join(cwd, "sub", "b.txt"), content: "hi" })
      expect(readFileSync(join(cwd, "sub", "b.txt"), "utf8")).toBe("hi")
    }),
  )

  it.effect("refuses paths outside the cwd, '..' and relative paths", () =>
    Effect.gen(function* () {
      const elsewhere = join(outside, "x.txt")
      expect(
        yield* failureOf(writeTextFile(deps(), { sessionId: "s", path: elsewhere, content: "x" })),
      ).toContain("outside the workspace")
      expect(
        yield* failureOf(
          writeTextFile(deps(), {
            sessionId: "s",
            path: join(cwd, "..", "outside", "y.txt"),
            content: "x",
          }),
        ),
      ).toContain("outside the workspace")
      expect(yield* failureOf(readTextFile(deps(), { sessionId: "s", path: "a.txt" }))).toContain("absolute")
      expect(() => readFileSync(elsewhere)).toThrow()
    }),
  )

  it.effect("refuses a symlink that points out of the cwd, for read and write", () =>
    Effect.gen(function* () {
      expect(
        yield* failureOf(readTextFile(deps(), { sessionId: "s", path: join(cwd, "peek.txt") })),
      ).toContain("outside the workspace")
      expect(
        yield* failureOf(
          writeTextFile(deps(), { sessionId: "s", path: join(cwd, "link", "z.txt"), content: "x" }),
        ),
      ).toContain("outside the workspace")
      expect(() => readFileSync(join(outside, "z.txt"))).toThrow()
    }),
  )

  it.effect(
    "an agent's fs/write_text_file outside the cwd gets a JSON-RPC error and nothing is written",
    () =>
      Effect.gen(function* () {
        const attempts: Array<string> = []
        const target = join(outside, "from-agent.txt")
        const { policy } = fakePolicy({ Write: "allow" })
        yield* runAgent(
          {
            onPrompt: async (call: PromptCall) => {
              const write = (path: string) =>
                call.client
                  .request(acp.methods.client.fs.writeTextFile, {
                    sessionId: call.params.sessionId,
                    path,
                    content: "pwned",
                  })
                  .then(() => "written")
                  .catch((error: unknown) => (error instanceof acp.RequestError ? error.message : "other"))
              attempts.push(await write(target), await write(join(cwd, "ok.txt")))
              return { stopReason: "end_turn" }
            },
          },
          policy,
          undefined,
          {
            readFile: (_c, rel) => tank.readFile(ctxIn(), rel),
            writeFile: (_c, rel, content) => tank.writeFile(ctxIn(), rel, content),
          },
        )
        expect(attempts).toEqual(["Invalid params: path is outside the workspace", "written"])
        expect(() => readFileSync(target)).toThrow()
        expect(readFileSync(join(cwd, "ok.txt"), "utf8")).toBe("pwned")
      }),
  )

  it.effect("the policy judges every read and write: a secret path is refused, other paths go through", () =>
    withRealPolicy((policy) =>
      Effect.gen(function* () {
        writeFileSync(join(cwd, ".env"), "KEY=1")
        expect(
          yield* failureOf(readTextFile(deps(policy), { sessionId: "s", path: join(cwd, ".env") })),
        ).toContain("not allowed")
        expect(
          yield* failureOf(
            writeTextFile(deps(policy), { sessionId: "s", path: join(cwd, ".env"), content: "x" }),
          ),
        ).toContain("not allowed")
        expect(readFileSync(join(cwd, ".env"), "utf8")).toBe("KEY=1")
        const ok = yield* readTextFile(deps(policy), { sessionId: "s", path: join(cwd, "a.txt") })
        expect(ok.content).toContain("two")
        // Outside the workspace a write asks, and ask is a refusal here.
        expect(
          yield* failureOf(
            writeTextFile(deps(policy), { sessionId: "s", path: join(outside, "n.txt"), content: "x" }),
          ),
        ).toContain("not allowed")
      }),
    ),
  )

  it.effect("a read-only run never writes, whatever the policy says", () =>
    Effect.gen(function* () {
      const target = join(cwd, "ro.txt")
      expect(
        yield* failureOf(writeTextFile(deps(allowAll, true), { sessionId: "s", path: target, content: "x" })),
      ).toContain("read-only")
      expect(() => readFileSync(target)).toThrow()
      const read = yield* readTextFile(deps(allowAll, true), { sessionId: "s", path: join(cwd, "a.txt") })
      expect(read.content).toContain("one")
    }),
  )

  it.effect("files over the byte cap are refused, read (sized before reading) and write", () =>
    Effect.gen(function* () {
      writeFileSync(join(cwd, "big.txt"), "x".repeat(FS_MAX_BYTES + 1))
      expect(
        yield* failureOf(readTextFile(deps(), { sessionId: "s", path: join(cwd, "big.txt") })),
      ).toContain("larger than")
      expect(
        yield* failureOf(
          writeTextFile(deps(), {
            sessionId: "s",
            path: join(cwd, "big2.txt"),
            content: "x".repeat(FS_MAX_BYTES + 1),
          }),
        ),
      ).toContain("larger than")
      expect(() => readFileSync(join(cwd, "big2.txt"))).toThrow()
      writeFileSync(join(cwd, "edge.txt"), "y".repeat(FS_MAX_BYTES))
      expect(
        (yield* readTextFile(deps(), { sessionId: "s", path: join(cwd, "edge.txt") })).content,
      ).toHaveLength(FS_MAX_BYTES)
    }),
  )

  it.effect("an agent write in a read-only run gets an error and the file is not created", () =>
    Effect.gen(function* () {
      const results: Array<string> = []
      yield* runAgent(
        {
          onPrompt: async (call: PromptCall) => {
            results.push(
              await call.client
                .request(acp.methods.client.fs.writeTextFile, {
                  sessionId: call.params.sessionId,
                  path: join(cwd, "ro-agent.txt"),
                  content: "x",
                })
                .then(() => "written")
                .catch((error: unknown) => (error instanceof acp.RequestError ? error.message : "other")),
            )
            return { stopReason: "end_turn" }
          },
        },
        allowAll,
        task({ permissionMode: "readonly" }),
        { writeFile: (_c, rel, content) => tank.writeFile(ctxIn(), rel, content) },
      )
      expect(results).toEqual(["Invalid params: this run is read-only"])
      expect(() => readFileSync(join(cwd, "ro-agent.txt"))).toThrow()
    }),
  )
})
