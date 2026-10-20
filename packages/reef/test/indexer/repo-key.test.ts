import { execFileSync } from "node:child_process"
import { resolve } from "node:path"
import { it } from "@effect/vitest"
import { repoKeyOf } from "@shoalwork/contracts"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { Indexer } from "../../src/indexer/indexer.js"
import { indexerEnv, withFixtureRepo } from "./helpers.js"

const HTTPS = "https://GitHub.com/renzer83/shoalwork.git"
const SSH = "ssh://git@github.com:22/renzer83/shoalwork.git"
const SCP = "git@github.com:renzer83/shoalwork.git"
const KEY = "github.com/renzer83/shoalwork"

describe("Indexer repo id", () => {
  it("is the repoKeyOf of the url, the same for the https, ssh and scp forms of one repo", () => {
    expect(repoKeyOf(HTTPS)).toBe(KEY)
    expect(repoKeyOf(SSH)).toBe(KEY)
    expect(repoKeyOf(SCP)).toBe(KEY)
  })

  it.effect("stores chunks under the same key whichever url form a run is given", () =>
    withFixtureRepo((repo) =>
      Effect.gen(function* () {
        const indexer = yield* Indexer
        const first = yield* indexer.index(repo.dir, { repoUrl: HTTPS })
        expect(first.repo).toBe(KEY)
        expect(first.chunks).toBeGreaterThan(0)
        // The same repo under the other two forms finds every chunk already stored: nothing is re-embedded.
        for (const url of [SSH, SCP]) {
          const again = yield* indexer.index(repo.dir, { repoUrl: url })
          expect(again.repo).toBe(KEY)
          expect(again.filesChanged).toBe(0)
          expect(again.chunksEmbedded).toBe(0)
          expect(again.chunks).toBe(first.chunks)
        }
      }),
    ).pipe(Effect.provide(indexerEnv())),
  )

  it.effect("takes the key from the origin remote when no url is given", () =>
    withFixtureRepo((repo) =>
      Effect.gen(function* () {
        execFileSync("git", ["remote", "add", "origin", HTTPS], { cwd: repo.dir, stdio: "ignore" })
        const indexer = yield* Indexer
        const report = yield* indexer.index(repo.dir)
        expect(report.repo).toBe(KEY)
      }),
    ).pipe(Effect.provide(indexerEnv())),
  )

  it.effect("keeps the absolute path when the directory has no remote and no url is given", () =>
    withFixtureRepo((repo) =>
      Effect.gen(function* () {
        const indexer = yield* Indexer
        const report = yield* indexer.index(repo.dir)
        expect(report.repo).toBe(resolve(repo.dir))
      }),
    ).pipe(Effect.provide(indexerEnv())),
  )

  it.effect("prefers an explicit repo id over the url", () =>
    withFixtureRepo((repo) =>
      Effect.gen(function* () {
        const indexer = yield* Indexer
        const report = yield* indexer.index(repo.dir, { repo: "explicit", repoUrl: HTTPS })
        expect(report.repo).toBe("explicit")
      }),
    ).pipe(Effect.provide(indexerEnv())),
  )
})
