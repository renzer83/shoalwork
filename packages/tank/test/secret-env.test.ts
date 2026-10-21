import { join } from "node:path"
import { it } from "@effect/vitest"
import { TankError } from "@shoalwork/contracts"
import { Effect, Redacted } from "effect"
import { describe, expect } from "vitest"
import { isSecretEnvRef } from "../src/env.js"
import { TankLocalLive } from "../src/local.js"
import { planLaunch } from "../src/sudo.js"
import { Tank } from "../src/tank.js"
import { makeBot, stepId, tempDir } from "./helpers.js"

const layer = TankLocalLive({ root: join(tempDir(), "tanks"), baseEnv: { PATH: process.env.PATH } })
const VALUE = ["mcp", "secret", "value", "42"].join("-")

describe("secret env of an execution (MCP servers)", () => {
  it("takes only the MCP_SECRET_<n> shape", () => {
    for (const ok of ["MCP_SECRET_0", "MCP_SECRET_12"]) expect(isSecretEnvRef(ok)).toBe(true)
    for (const bad of [
      "NOTION_API_KEY",
      "PATH",
      "HOME",
      "NODE_OPTIONS",
      "LD_PRELOAD",
      "PYTHONHOME",
      "MCP_SECRET_",
      "MCP_SECRET_X",
      "MCP_SECRET_0; rm",
      "mcp_secret_0",
      "",
    ])
      expect(isSecretEnvRef(bad)).toBe(false)
  })

  it.live("puts the value in the process env and in stepEnv, nowhere else", () =>
    Effect.gen(function* () {
      const tank = yield* Tank
      const ctx = yield* tank.prepare(makeBot("secret-bot"), {
        stepId: stepId(),
        secretEnv: { MCP_SECRET_0: Redacted.make(VALUE) },
      })
      expect(ctx.env.MCP_SECRET_0).toBe(VALUE)
      expect(ctx.stepEnv?.MCP_SECRET_0).toBe(VALUE)
      const res = yield* tank.exec(ctx, ["env"])
      expect(res.stdout).toContain(`MCP_SECRET_0=${VALUE}`)
    }).pipe(Effect.provide(layer)),
  )

  it.live("refuses any other name, without echoing the value", () =>
    Effect.gen(function* () {
      const tank = yield* Tank
      for (const name of ["NODE_OPTIONS", "NOTION_API_KEY", "PYTHONHOME"]) {
        const failure = yield* Effect.flip(
          tank.prepare(makeBot("secret-bot-2"), {
            stepId: stepId(),
            secretEnv: { [name]: Redacted.make(VALUE) },
          }),
        )
        expect(failure).toBeInstanceOf(TankError)
        expect(JSON.stringify(failure)).not.toContain(VALUE)
      }
    }).pipe(Effect.provide(layer)),
  )

  it("server mode: the name goes to --preserve-env, the value only to the sudo process env", async () => {
    const plan = await Effect.runPromise(
      planLaunch(
        true,
        "bot-a",
        {
          cmd: ["codex", "exec"],
          env: { HOME: "/h", MCP_SECRET_0: VALUE },
          passEnv: { MCP_SECRET_0: VALUE },
        },
        { PATH: "/usr/bin" },
      ),
    )
    expect(plan.argv).toContain("--preserve-env=MCP_SECRET_0")
    expect(plan.argv.join(" ")).not.toContain(VALUE)
    expect(plan.env.MCP_SECRET_0).toBe(VALUE)
  })
})
