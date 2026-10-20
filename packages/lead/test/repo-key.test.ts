import { describe, expect, it } from "vitest"
import { repoKeyOf } from "../src/repo-key.js"

describe("repoKeyOf", () => {
  it("drops credentials, the .git suffix and trailing slashes, and lowercases only the host", () => {
    expect(repoKeyOf("https://user:pass@GitHub.com/Renzer83/Shoalwork.git/")).toBe(
      "github.com/Renzer83/Shoalwork",
    )
  })

  it("drops the scheme's default port, and keeps a port that is not the default", () => {
    expect(repoKeyOf("https://github.com:443/renzer83/shoalwork")).toBe("github.com/renzer83/shoalwork")
    expect(repoKeyOf("ssh://git@host:22/p")).toBe("host/p")
    expect(repoKeyOf("ssh://git@host:2222/p")).toBe("host:2222/p")
  })

  it("gives the same key to the same repo written as an ssh url or an scp-like address", () => {
    const key = repoKeyOf("https://github.com/renzer83/shoalwork")
    expect(repoKeyOf("ssh://git@GitHub.com:22/renzer83/shoalwork.git")).toBe(key)
    expect(repoKeyOf("git@GitHub.com:renzer83/shoalwork.git")).toBe(key)
  })

  it("strips credentials written without a scheme", () => {
    expect(repoKeyOf("user:pass@host/path")).toBe("host/path")
  })

  it("decodes a file url and keeps local paths, without a trailing slash or .git", () => {
    expect(repoKeyOf("file:///srv/git/my%20repo.git")).toBe("/srv/git/my repo")
    expect(repoKeyOf("/work/repo.git/")).toBe("/work/repo")
  })
})
