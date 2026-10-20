import type { Dirent } from "node:fs"
import { readdir, readFile, realpath, stat } from "node:fs/promises"
import { join, relative, sep } from "node:path"
import { Effect } from "effect"
import { DEFAULT_MAX_FILE_BYTES, isIgnoredPath, looksLikeSecret, WalkError } from "./indexer/walk.js"

// Directory walk of the markdown importer. Reads only inside the root: a symlink is judged by its target.
const PRUNED_DIRS = new Set(["node_modules", ".git", ".obsidian"])
const BINARY_SNIFF_BYTES = 8 * 1024

export type SkipReason = "ignored" | "outside_root" | "too_large" | "binary" | "not_a_file" | "unreadable"

export interface SkippedFile {
  readonly path: string
  readonly reason: SkipReason
}

// Every refusal is a value (skipped or rejected), never a throw.
export type Outcome =
  | { readonly status: "text"; readonly text: string }
  | { readonly status: "rejected" }
  | { readonly status: "skipped"; readonly reason: SkipReason }

export interface Listing {
  // Markdown candidates relative to the root, "/" separated, sorted.
  readonly paths: ReadonlyArray<string>
  readonly skipped: ReadonlyArray<SkippedFile>
}

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

// Canonical root of the import; fails when it is missing or not a directory.
export const resolveRoot = (dir: string): Effect.Effect<string, WalkError> =>
  Effect.tryPromise({
    try: async () => {
      const root = await realpath(dir)
      if (!(await stat(root)).isDirectory()) {
        throw new Error("not a directory")
      }
      return root
    },
    catch: (cause) => new WalkError({ reason: "io", detail: messageOf(cause) }),
  })

const collect = async (
  root: string,
  prefix: string,
  paths: Array<string>,
  skipped: Array<SkippedFile>,
): Promise<void> => {
  let entries: Array<Dirent>
  try {
    entries = await readdir(join(root, prefix), { withFileTypes: true })
  } catch (cause) {
    if (prefix === "") {
      throw cause
    }
    skipped.push({ path: prefix, reason: "unreadable" })
    return
  }
  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      if (!PRUNED_DIRS.has(entry.name)) {
        await collect(root, rel, paths, skipped)
      }
    } else if (entry.name.endsWith(".md") && (entry.isFile() || entry.isSymbolicLink())) {
      paths.push(rel)
    }
  }
}

// Lists "*.md" files without following symlinked directories. An unreadable subdirectory is skipped; an unreadable
// root fails with WalkError.
export const listMarkdown = (root: string): Effect.Effect<Listing, WalkError> =>
  Effect.tryPromise({
    try: async () => {
      const paths: Array<string> = []
      const skipped: Array<SkippedFile> = []
      await collect(root, "", paths, skipped)
      paths.sort()
      return { paths, skipped }
    },
    catch: (cause) => new WalkError({ reason: "io", detail: messageOf(cause) }),
  })

const within = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)

// Reads one listed file under the root. Missing, outside, ignored, too big, binary or secret-looking files are
// reported as outcomes; no error escapes.
export const inspectFile = async (root: string, path: string): Promise<Outcome> => {
  const skip = (reason: SkipReason): Outcome => ({ status: "skipped", reason })
  if (isIgnoredPath(path)) {
    return skip("ignored")
  }
  try {
    const real = await realpath(join(root, path))
    if (!within(root, real)) {
      return skip("outside_root")
    }
    // A link to a secret looks harmless by name: the target is judged too.
    if (isIgnoredPath(relative(root, real).split(sep).join("/"))) {
      return skip("ignored")
    }
    const info = await stat(real)
    if (!info.isFile()) {
      return skip("not_a_file")
    }
    if (info.size > DEFAULT_MAX_FILE_BYTES) {
      return skip("too_large")
    }
    const bytes = await readFile(real)
    if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
      return skip("binary")
    }
    const text = bytes.toString("utf8")
    return looksLikeSecret(text) ? { status: "rejected" } : { status: "text", text }
  } catch {
    return skip("unreadable")
  }
}
