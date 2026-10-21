import { mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { isInside } from "../src/confine.js"
import { makeTankLocal } from "../src/local.js"
import type { TankContext } from "../src/tank.js"
import { makeBot, tempDir } from "./helpers.js"

describe("isInside", () => {
  it("accepts names that merely start with two dots and refuses real climbs", () => {
    expect(isInside("/w", "/w")).toBe(true)
    expect(isInside("/w", "/w/a/b")).toBe(true)
    expect(isInside("/w", "/w/..hidden")).toBe(true)
    expect(isInside("/w", "/w/..a/b")).toBe(true)
    expect(isInside("/w", "/")).toBe(false)
    expect(isInside("/w", "/x")).toBe(false)
    expect(isInside("/w", "/w/../x")).toBe(false)
    expect(isInside("/w", "/wx")).toBe(false)
  })
})

describe("local Tank file confinement", () => {
  const root = tempDir()
  const cwd = join(root, "cwd")
  mkdirSync(cwd, { recursive: true })
  mkdirSync(join(root, "elsewhere"))
  writeFileSync(join(cwd, "..hidden"), "dots")
  writeFileSync(join(root, "elsewhere", "x.txt"), "outside")
  symlinkSync(join(root, "elsewhere", "x.txt"), join(cwd, "link"))
  const bot = makeBot("alice")
  const ctx: TankContext = { botId: bot.id, botName: "alice", cwd, home: join(root, "home"), env: {} }
  const tank = makeTankLocal({ root, baseEnv: { PATH: process.env.PATH } })

  it.live("reads and writes a ..name file inside the cwd", () =>
    Effect.gen(function* () {
      expect(yield* tank.readFile(ctx, "..hidden")).toBe("dots")
      yield* tank.writeFile(ctx, "..other", "more")
      expect(yield* tank.readFile(ctx, "..other")).toBe("more")
    }),
  )

  it.live("still refuses ../ and a link that leaves the cwd", () =>
    Effect.gen(function* () {
      const climb = yield* Effect.result(tank.readFile(ctx, "../elsewhere/x.txt"))
      const linked = yield* Effect.result(tank.readFile(ctx, "link"))
      expect(climb._tag).toBe("Failure")
      expect(linked._tag).toBe("Failure")
    }),
  )
})
