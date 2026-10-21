import { execFile } from "node:child_process"
import { lstat, readFile, realpath, stat } from "node:fs/promises"
import { join, relative, sep } from "node:path"
import { Data, Effect } from "effect"

export const DEFAULT_MAX_FILE_BYTES = 200 * 1024
const BINARY_SNIFF_BYTES = 8 * 1024
const GIT_MAX_BUFFER = 256 * 1024 * 1024

export class WalkError extends Data.TaggedError("WalkError")<{
  readonly reason: "git" | "io"
  readonly detail: string
}> {}

export interface WalkOptions {
  readonly maxFileBytes?: number | undefined
}

export interface WalkedFile {
  readonly path: string // relative to the repo root, "/" separated
  readonly content: string
}

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

const GIT_TIMEOUT_MS = 60_000
const GIT_LOG_TIMEOUT_MS = 15_000
// A parent shell may export these; they would make `git -C <dir>` read some other repository.
const GIT_ENV_STRIPPED = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"])

const SKIPPED_NAMES = new Set([
  ".git",
  "pnpm-lock.yaml",
  ".npmrc",
  ".netrc",
  ".pypirc",
  ".htpasswd",
  ".git-credentials",
  ".dockercfg",
  ".dockerconfigjson",
])
const SKIPPED_DIRS = new Set(["dist", ".git", ".ssh", ".aws", ".gnupg", "secrets"])
const SECRET_BASENAME: ReadonlyArray<RegExp> = [
  /^\.env/,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/,
  /\.(?:pem|key|p12|pfx|jks|keystore|tfvars|kdbx)$/i,
  /\.tfstate/i,
  /^credentials/i,
  /^secrets/i,
  /^service-account.*\.json$/i,
]

// Path-only rules: no file I/O. Secrets by name never reach the content check.
export const isIgnoredPath = (path: string): boolean => {
  const segments = path.split("/")
  const base = segments[segments.length - 1] ?? path
  if (segments.slice(0, -1).some((segment) => SKIPPED_DIRS.has(segment)) || SKIPPED_NAMES.has(base)) {
    return true
  }
  if (/\.min\.[^/]+$/.test(base)) {
    return true
  }
  return SECRET_BASENAME.some((pattern) => pattern.test(base))
}

// Stand-in for a gitleaks pass: well-known token shapes and private key blocks. The bracketed characters keep this
// source from matching the repo's own secret grep.
const SECRET_CONTENT: ReadonlyArray<RegExp> = [
  /-----BEGIN [A-Z ]*PRIVATE KEY/,
  /sk-a[n]t-[\w-]{16,}/,
  /sk-pro[j]-[\w-]{16,}/,
  /gh[pousr]_[A-Za-z0-9]{30,}/,
  /github_pa[t]_\w{20,}/,
  /AKI[A][0-9A-Z]{16}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /AIza[0-9A-Za-z_-]{35}/,
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/,
]

export const looksLikeSecret = (text: string): boolean => SECRET_CONTENT.some((pattern) => pattern.test(text))

const gitEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([key]) => !GIT_ENV_STRIPPED.has(key)))

// Tracked and untracked-but-not-ignored files; git applies .gitignore. A tracked file deleted on disk still shows up
// here, and is dropped later when it cannot be read.
export const listRepoFiles = (repoDir: string): Effect.Effect<ReadonlyArray<string>, WalkError> =>
  Effect.tryPromise({
    try: (signal) =>
      new Promise<string>((resolve, reject) => {
        execFile(
          "git",
          ["-C", repoDir, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
          { encoding: "utf8", maxBuffer: GIT_MAX_BUFFER, timeout: GIT_TIMEOUT_MS, signal, env: gitEnv() },
          (error, stdout) => (error === null ? resolve(stdout) : reject(error)),
        )
      }),
    catch: (cause) => new WalkError({ reason: "git", detail: messageOf(cause) }),
  }).pipe(
    Effect.map((stdout) =>
      [...new Set(stdout.split("\0").filter((entry) => entry !== ""))]
        .filter((path) => !isIgnoredPath(path))
        .sort(),
    ),
  )

// The url of the repo's origin remote, or undefined when there is none (or git cannot say). Argv only, bounded in time.
export const originUrlOf = (repoDir: string): Effect.Effect<string | undefined> =>
  Effect.tryPromise({
    try: (signal) =>
      new Promise<string>((resolve, reject) => {
        execFile(
          "git",
          ["-C", repoDir, "remote", "get-url", "origin"],
          { encoding: "utf8", maxBuffer: GIT_MAX_BUFFER, timeout: GIT_TIMEOUT_MS, signal, env: gitEnv() },
          (error, stdout) => (error === null ? resolve(stdout) : reject(error)),
        )
      }),
    catch: (cause) => cause,
  }).pipe(
    Effect.map((stdout) => {
      const url = stdout.trim()
      return url === "" ? undefined : url
    }),
    Effect.catch(() => Effect.succeed(undefined)),
  )

// ISO-8601 UTC instant of the last commit that touched `path` (`git log -1 --format=%ct -- <path>`), or undefined when
// git has none (untracked file) or cannot say. The path is literal (`[id].ts` is not a glob). Argv only, bounded in time.
export const lastCommitIso = (repoDir: string, path: string): Effect.Effect<string | undefined> =>
  Effect.tryPromise({
    try: (signal) =>
      new Promise<string>((resolve, reject) => {
        execFile(
          "git",
          ["--literal-pathspecs", "-C", repoDir, "log", "-1", "--format=%ct", "--", path],
          { encoding: "utf8", maxBuffer: 1024, timeout: GIT_LOG_TIMEOUT_MS, signal, env: gitEnv() },
          (error, stdout) => (error === null ? resolve(stdout) : reject(error)),
        )
      }),
    catch: (cause) => cause,
  }).pipe(
    Effect.map((stdout) => {
      const seconds = Number.parseInt(stdout.trim(), 10)
      return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : undefined
    }),
    Effect.catch(() => Effect.succeed(undefined)),
  )

// Anything that makes one file unreadable (gone, loop, permissions, not a file, name too long) skips that file only.
const SKIPPABLE_CODES = new Set(["ENOENT", "ENOTDIR", "ELOOP", "EACCES", "EPERM", "EISDIR", "ENAMETOOLONG"])
const isSkippable = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && SKIPPABLE_CODES.has(String(cause.code))

const within = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)

// Content of a file that may be indexed, or null when it must not be: missing, outside the repo (symlink), not a
// regular file, too big, binary or secret-looking. `repoRoot` is the realpath of the repo directory.
export const readIndexable = (
  repoRoot: string,
  path: string,
  options: WalkOptions = {},
): Effect.Effect<string | null, WalkError> =>
  Effect.tryPromise({
    try: async () => {
      const limit = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
      const absolute = join(repoRoot, path)
      try {
        await lstat(absolute)
        const real = await realpath(absolute)
        if (!within(repoRoot, real)) {
          return null
        }
        // A link inside the repo may still point at a secret (".env", ".git/config"): judge the target too.
        if (isIgnoredPath(relative(repoRoot, real).split(sep).join("/"))) {
          return null
        }
        const info = await stat(real)
        if (!info.isFile() || info.size > limit) {
          return null
        }
        const bytes = await readFile(real)
        if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
          return null
        }
        const text = bytes.toString("utf8")
        return looksLikeSecret(text) ? null : text
      } catch (cause) {
        if (isSkippable(cause)) {
          return null
        }
        throw cause
      }
    },
    catch: (cause) => new WalkError({ reason: "io", detail: `${path}: ${messageOf(cause)}` }),
  })

export const resolveRepoRoot = (repoDir: string): Effect.Effect<string, WalkError> =>
  Effect.tryPromise({
    try: () => realpath(repoDir),
    catch: (cause) => new WalkError({ reason: "io", detail: messageOf(cause) }),
  })

// Convenience for callers (and tests) that want everything in memory.
export const walkRepo = (
  repoDir: string,
  options: WalkOptions = {},
): Effect.Effect<ReadonlyArray<WalkedFile>, WalkError> =>
  Effect.gen(function* () {
    const root = yield* resolveRepoRoot(repoDir)
    const paths = yield* listRepoFiles(root)
    const files: Array<WalkedFile> = []
    for (const path of paths) {
      const content = yield* readIndexable(root, path, options)
      if (content !== null) {
        files.push({ path, content })
      }
    }
    return files
  })
