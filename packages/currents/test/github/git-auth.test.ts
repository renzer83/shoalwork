import { describe, expect, it } from "vitest"
import { GIT_CREDENTIAL_ARGV, GIT_TOKEN_ENV, withGitToken } from "../../src/github/git-auth.js"

const TOKEN = "ghs_installation_secret"

describe("git over an installation token", () => {
  it("the credential argv never carries the token: the helper reads it from its env", () => {
    expect(JSON.stringify(GIT_CREDENTIAL_ARGV)).not.toContain(TOKEN)
    expect(GIT_CREDENTIAL_ARGV.join(" ")).toContain(`$${GIT_TOKEN_ENV}`)
    expect(GIT_CREDENTIAL_ARGV[0]).toBe("-c")
    expect(GIT_CREDENTIAL_ARGV[1]).toBe("credential.helper=")
  })

  it("withGitToken puts the token in env and stepEnv of a new context, leaving the original as it was", () => {
    const ctx = { env: { HOME: "/home/bot" }, stepEnv: { SHOALWORK_OTHER: "1" }, cwd: "/work" }
    const next = withGitToken(ctx, TOKEN)
    expect(next.env).toEqual({ HOME: "/home/bot", [GIT_TOKEN_ENV]: TOKEN })
    expect(next.stepEnv).toEqual({ SHOALWORK_OTHER: "1", [GIT_TOKEN_ENV]: TOKEN })
    expect(next.cwd).toBe("/work")
    expect(ctx.env).toEqual({ HOME: "/home/bot" })
    expect(ctx.stepEnv).toEqual({ SHOALWORK_OTHER: "1" })
  })
})
