import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { isIgnoredPath, listRepoFiles, looksLikeSecret, WalkError, walkRepo } from "../../src/indexer/walk.js"
import { INDEXABLE_PATHS } from "../fixtures/repo/files.js"
import { withFixtureRepo } from "./helpers.js"

describe("walkRepo", () => {
  it.effect("returns only text sources: no binary, huge, ignored, secret or out-of-repo files", () =>
    withFixtureRepo((repo) =>
      Effect.gen(function* () {
        const files = yield* walkRepo(repo.dir)
        expect(files.map((file) => file.path)).toEqual(INDEXABLE_PATHS)
        expect(files.find((file) => file.path === "src/app.ts")?.content).toContain("export function alpha")
      }),
    ),
  )

  it.effect("never lists names that carry secrets or build output", () =>
    withFixtureRepo((repo) =>
      Effect.gen(function* () {
        const paths = yield* listRepoFiles(repo.dir)
        for (const hidden of [
          ".env",
          ".env.local",
          "keys/server.pem",
          "id_rsa",
          "id_ed25519.pub",
          "pnpm-lock.yaml",
          "dist/out.js",
          "vendor/app.min.js",
          "ignored.log",
          "build-out/generated.ts",
        ]) {
          expect(paths).not.toContain(hidden)
        }
      }),
    ),
  )

  it.effect("skips secret-looking contents and does not follow a symlink that leaves the repo", () =>
    withFixtureRepo((repo) =>
      Effect.gen(function* () {
        const paths = (yield* walkRepo(repo.dir)).map((file) => file.path)
        expect(paths).not.toContain("config/leak.ts")
        expect(paths).not.toContain("config/pk.ts")
        expect(paths).not.toContain("link-out.ts")
      }),
    ),
  )

  it.effect("does not index secrets reached through a symlink inside the repo, nor symlink loops", () =>
    withFixtureRepo((repo) =>
      Effect.gen(function* () {
        const listed = yield* listRepoFiles(repo.dir)
        for (const link of ["notes.txt", "gitcfg.txt", "loop-a", "loop-b"]) {
          expect(listed).toContain(link)
        }
        const files = yield* walkRepo(repo.dir)
        expect(files.map((file) => file.path)).toEqual(INDEXABLE_PATHS)
        expect(files.some((file) => file.content.includes("API_URL"))).toBe(false)
      }),
    ),
  )

  it.effect("skips a file it cannot read instead of failing the walk", () =>
    withFixtureRepo((repo) =>
      Effect.gen(function* () {
        const target = join(repo.dir, "locked.ts")
        writeFileSync(target, "export const locked = 1\n")
        chmodSync(target, 0o000)
        const files = yield* walkRepo(repo.dir).pipe(
          Effect.ensuring(Effect.sync(() => chmodSync(target, 0o600))),
        )
        expect(files.map((file) => file.path)).not.toContain("locked.ts")
        expect(files.map((file) => file.path)).toContain("src/app.ts")
      }),
    ),
  )

  it.effect("honours the configured size limit", () =>
    withFixtureRepo((repo) =>
      Effect.gen(function* () {
        const files = yield* walkRepo(repo.dir, { maxFileBytes: 40 })
        expect(files.map((file) => file.path)).toEqual([".gitignore"])
      }),
    ),
  )

  it.effect("fails with a typed error outside a git work tree", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "shoalwork-nogit-"))
      const error = yield* Effect.flip(walkRepo(dir)).pipe(
        Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true }))),
      )
      expect(error).toBeInstanceOf(WalkError)
      expect(error.reason).toBe("git")
    }),
  )
})

describe("path and content rules", () => {
  const ignored = [
    "a/.env",
    ".env.production",
    "x/id_rsa",
    "x/id_ed25519.pub",
    "id_ecdsa",
    "id_dsa",
    "k/cert.PEM",
    "s/tls.key",
    "pnpm-lock.yaml",
    "a/b.min.css",
    "pkg/dist/x.js",
    "infra/prod.tfvars",
    "infra/terraform.tfstate",
    "infra/terraform.tfstate.backup",
    "aws/credentials",
    "credentials.json",
    "secrets.yaml",
    "gcp/service-account-prod.json",
    ".pypirc",
    "web/.htpasswd",
    "home/.git-credentials",
    ".dockercfg",
    "k8s/.dockerconfigjson",
    "vault/db.kdbx",
    ".ssh/config",
    "home/.aws/config",
    ".gnupg/pubring.kbx",
    "app/secrets/db.ts",
    ".git/config",
    ".npmrc",
    ".netrc",
  ]
  const kept = [
    "src/environment.ts",
    "src/distance.ts",
    "docs/guide.ts",
    "src/dist.ts",
    "src/id_utils.ts",
    "src/id_rsa_helpers.ts",
    "src/secret-santa.ts",
    "src/service-account.ts",
    "src/keys.ts",
  ]

  it("flags secret names, lockfiles, minified files and secret directories", () => {
    for (const path of ignored) {
      expect(isIgnoredPath(path), path).toBe(true)
    }
  })

  it("keeps ordinary source names", () => {
    for (const path of kept) {
      expect(isIgnoredPath(path), path).toBe(false)
    }
  })

  it("recognises token shapes and private key blocks but not ordinary code", () => {
    expect(looksLikeSecret(["sk", "ant", "y".repeat(30)].join("-"))).toBe(true)
    expect(looksLikeSecret(`${"AKI"}${"A"}${"B".repeat(16)}`)).toBe(true)
    expect(looksLikeSecret(`${"-----BEGIN"} OPENSSH ${"PRIVATE"} KEY-----`)).toBe(true)
    expect(looksLikeSecret("export function skip() { return 'task-1' }")).toBe(false)
  })
})
