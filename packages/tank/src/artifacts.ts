import { createHash } from "node:crypto"
import { chmod, lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { type Artifact, BotId, TankError, type TaskId } from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import { isInside } from "./confine.js"

// What a Bot produced for a task, copied out of its worktree so that another Bot (or Renan) can read it without the
// worktree (T-046). Large content travels as a file: the messages carry the reference, the manifest says what it is.
export const ArtifactEntry = Schema.Struct({
  // Relative to the task's artifacts directory, "/" separated.
  path: Schema.String,
  sha256: Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/))),
  bytes: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  producedBy: BotId,
})
export type ArtifactEntry = typeof ArtifactEntry.Type

export const ArtifactManifest = Schema.Struct({ files: Schema.Array(ArtifactEntry) })
export type ArtifactManifest = typeof ArtifactManifest.Type

export const MANIFEST_NAME = "manifest.json"
export const ARTIFACT_MAX_FILE_BYTES = 10 * 1024 * 1024
// Mode of a task's artifacts directory: group-shared and setgid, so the files inherit the group (T-172).
export const ARTIFACTS_DIR_MODE = 0o2775
export const ARTIFACT_MAX_TOTAL_BYTES = 50 * 1024 * 1024

export interface ArtifactLimits {
  readonly maxFileBytes: number
  readonly maxTotalBytes: number
}

// The secret filter of the Reef's walker, passed in by the caller so that tank keeps no dependency on reef.
// `refusePath` judges the name (".env", keys, credentials); `refuseContent` judges the text. Both fail closed.
export interface ArtifactScreen {
  readonly refusePath: (relPath: string) => boolean
  readonly refuseContent: (text: string) => boolean
}

export interface PublishInput {
  // The Tank root (<TANK_ROOT>): artifacts live under <root>/_shared/artifacts/<taskId>.
  readonly root: string
  readonly taskId: TaskId
  readonly producedBy: BotId
  // The working directory of the run that produced the files; every source must stay inside it.
  readonly cwd: string
  // Source paths relative to cwd.
  readonly files: ReadonlyArray<string>
  readonly screen: ArtifactScreen
  readonly limits?: ArtifactLimits
  // Applied to the task directory before its first file (server mode: the shared group, T-172).
  readonly setGroup?: ((dir: string) => Effect.Effect<void, TankError>) | undefined
}

// What a Tank needs from a caller to publish a run: the root and the group belong to the Tank, not to the caller.
export type PublishRun = Omit<PublishInput, "root" | "setGroup">

export interface PublishedArtifacts {
  readonly manifest: ArtifactManifest
  // One Artifact per copied file, kind "file", ref = absolute path of the copy.
  readonly artifacts: ReadonlyArray<Artifact>
}

// <root>/_shared/artifacts/<taskId>. The leading underscore keeps it apart from every Bot directory (bot names never
// start with one), so no Bot can be named after it.
export const artifactsDir = (root: string, taskId: TaskId): string =>
  join(resolve(root), "_shared", "artifacts", taskId)

// Only plain relative paths: no absolute, no empty or dot segments, no backslashes, no NUL.
const plainRelative = (rel: string): boolean =>
  rel !== "" &&
  !isAbsolute(rel) &&
  !rel.includes("\\") &&
  !rel.includes("\0") &&
  rel.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")

// Throws a TankError: the async body below is wrapped with Effect.tryPromise, which keeps TankError as it is.
const refuse = (why: string): never => {
  throw new TankError({ op: "artifacts", cause: why })
}

const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

const isEnoent = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT"

// Every existing component from `base` (exclusive) down to `target` is a real entry, not a symlink. A component that
// does not exist yet cannot be a link, and nothing below it either.
const noSymlinkBetween = async (base: string, target: string, rel: string): Promise<void> => {
  let current = base
  for (const segment of relative(base, target)
    .split(sep)
    .filter((part) => part !== "")) {
    current = join(current, segment)
    const info = await lstat(current).catch((cause: unknown) => {
      if (isEnoent(cause)) return undefined
      throw cause
    })
    if (info === undefined) return
    if (info.isSymbolicLink()) refuse(`artifact path crosses a symlink: ${rel}`)
  }
}

interface Source {
  readonly rel: string
  readonly bytes: Buffer
}

// Reads and judges every source before anything is written: one refused file refuses the whole publication.
const readSources = async (input: PublishInput, limits: ArtifactLimits): Promise<ReadonlyArray<Source>> => {
  const cwd = resolve(input.cwd)
  const realCwd = await realpath(cwd)
  const seen = new Set<string>()
  const sources: Array<Source> = []
  let total = 0
  for (const rel of input.files) {
    if (!plainRelative(rel)) refuse(`unsafe artifact path: ${JSON.stringify(rel)}`)
    if (rel === MANIFEST_NAME) refuse(`reserved artifact name: ${MANIFEST_NAME}`)
    if (seen.has(rel)) refuse(`duplicate artifact path: ${JSON.stringify(rel)}`)
    seen.add(rel)
    const target = resolve(cwd, rel)
    if (!isInside(cwd, target)) refuse(`artifact path escapes the worktree: ${JSON.stringify(rel)}`)
    await noSymlinkBetween(cwd, target, rel)
    const realTarget = await realpath(target).catch((cause: unknown) => {
      if (isEnoent(cause)) refuse(`missing artifact: ${JSON.stringify(rel)}`)
      throw cause
    })
    if (!isInside(realCwd, realTarget))
      refuse(`artifact resolves outside the worktree: ${JSON.stringify(rel)}`)
    const info = await stat(target)
    if (!info.isFile()) refuse(`artifact is not a regular file: ${JSON.stringify(rel)}`)
    if (info.size > limits.maxFileBytes) refuse(`artifact over the per-file limit: ${JSON.stringify(rel)}`)
    total += info.size
    if (total > limits.maxTotalBytes) refuse("artifacts over the total limit")
    if (input.screen.refusePath(rel)) refuse(`artifact refused by name: ${JSON.stringify(rel)}`)
    const bytes = await readFile(target)
    if (input.screen.refuseContent(bytes.toString("utf8"))) {
      refuse(`artifact refused: secret-looking content in ${JSON.stringify(rel)}`)
    }
    sources.push({ rel, bytes })
  }
  return sources
}

// Copies the sources into the task's directory and writes manifest.json there. Returns one `file` Artifact per copy.
const writeCopies = async (
  dir: string,
  producedBy: BotId,
  sources: ReadonlyArray<Source>,
): Promise<ReadonlyArray<Artifact>> => {
  const realDir = await realpath(dir)
  const entries: Array<ArtifactEntry> = []
  const artifacts: Array<Artifact> = []
  for (const source of sources) {
    const dest = resolve(dir, source.rel)
    if (!isInside(dir, dest)) refuse(`artifact destination escapes the task directory: ${source.rel}`)
    await mkdir(dirname(dest), { recursive: true })
    await noSymlinkBetween(dir, dest, source.rel)
    const realParent = await realpath(dirname(dest))
    if (!isInside(realDir, realParent)) refuse(`artifact destination resolves outside: ${source.rel}`)
    const existing = await lstat(dest).catch((cause: unknown) => {
      if (isEnoent(cause)) return undefined
      throw cause
    })
    if (existing?.isSymbolicLink() === true) refuse(`artifact destination is a symlink: ${source.rel}`)
    await writeFile(dest, source.bytes)
    entries.push({
      path: source.rel,
      sha256: sha256Of(source.bytes),
      bytes: source.bytes.byteLength,
      producedBy,
    })
    artifacts.push({ kind: "file", ref: dest })
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  await writeFile(join(dir, MANIFEST_NAME), `${JSON.stringify({ files: entries }, null, 2)}\n`, "utf8")
  return artifacts
}

// Any failure of a filesystem step is a TankError (a TankError raised inside the step is kept as it is).
const fsStep = <A>(step: () => Promise<A>): Effect.Effect<A, TankError> =>
  Effect.tryPromise({
    try: step,
    catch: (cause) => (cause instanceof TankError ? cause : new TankError({ op: "artifacts", cause })),
  })

// Copies the sources into the task's artifacts directory and writes manifest.json there, then reads it back and
// validates it. Returns the manifest and one `file` Artifact per copy. Every failure is a TankError; nothing is
// written when a source is refused (the copies are written after all of them passed). The group, when set, is
// applied to the directory before its first file, so that the files inherit it (setgid).
export const publishArtifacts = (input: PublishInput): Effect.Effect<PublishedArtifacts, TankError> => {
  const limits = input.limits ?? {
    maxFileBytes: ARTIFACT_MAX_FILE_BYTES,
    maxTotalBytes: ARTIFACT_MAX_TOTAL_BYTES,
  }
  const dir = artifactsDir(input.root, input.taskId)
  const nothing: PublishedArtifacts = { manifest: { files: [] }, artifacts: [] }
  return fsStep(() => readSources(input, limits)).pipe(
    // A run with no files publishes nothing: no directory, no manifest.
    Effect.flatMap((sources) =>
      sources.length === 0
        ? Effect.succeed(nothing)
        : fsStep(() => mkdir(dir, { recursive: true, mode: ARTIFACTS_DIR_MODE })).pipe(
            Effect.flatMap(() => (input.setGroup === undefined ? Effect.void : input.setGroup(dir))),
            Effect.flatMap(() => fsStep(() => chmod(dir, ARTIFACTS_DIR_MODE))),
            Effect.flatMap(() => fsStep(() => writeCopies(dir, input.producedBy, sources))),
            Effect.flatMap((artifacts) =>
              // Read back and validate what was written: the manifest on disk is the record, not the value in memory.
              readArtifactManifest(input.root, input.taskId).pipe(
                Effect.map((manifest): PublishedArtifacts => ({ manifest, artifacts })),
              ),
            ),
          ),
    ),
  )
}

// The manifest of a task's artifacts, decoded from disk (fails with TankError when it is missing or not valid).
export const readArtifactManifest = (
  root: string,
  taskId: TaskId,
): Effect.Effect<ArtifactManifest, TankError> =>
  Effect.tryPromise({
    try: () => readFile(join(artifactsDir(root, taskId), MANIFEST_NAME), "utf8"),
    catch: (cause) => new TankError({ op: "artifacts", cause }),
  }).pipe(
    Effect.flatMap((text) =>
      Effect.try({
        try: (): unknown => JSON.parse(text),
        catch: (cause) => new TankError({ op: "artifacts", cause }),
      }),
    ),
    Effect.flatMap((raw) =>
      Schema.decodeUnknownEffect(ArtifactManifest)(raw).pipe(
        Effect.mapError((error) => new TankError({ op: "artifacts", cause: error })),
      ),
    ),
  )
