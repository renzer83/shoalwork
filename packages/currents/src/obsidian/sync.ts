import { isAbsolute } from "node:path"
import { Data, Effect } from "effect"

// The label every Obsidian chunk carries as its source, and the directories the vault keeps for templates. The importer
// already prunes .obsidian/ and node_modules/, .git/ at any depth.
export const OBSIDIAN_SOURCE = "obsidian"
export const OBSIDIAN_EXCLUDED_DIRS: ReadonlyArray<string> = ["templates"]

// A memory import failed. Shared by the Drive and the Obsidian sync; it lives here so this module does not depend on
// drive/.
export class MemoryImportError extends Data.TaggedError("MemoryImportError")<{
  readonly source: string
  readonly message: string
}> {}

export class ObsidianError extends Data.TaggedError("ObsidianError")<{
  readonly message: string
}> {}

// What the importer did with one vault: the counts that matter to the sync. A rerun over an unchanged vault has
// created 0 and superseded 0.
export interface MarkdownImportReport {
  readonly created: number
  readonly superseded: number
  readonly unchanged: number
  readonly forgotten: number
}

export interface MarkdownImportRequest {
  readonly dir: string
  readonly source: string
  readonly exclude: ReadonlyArray<string>
}

// The Reef's importMarkdownDir (T-038) with scope "global", ownerId "global" and kind "semantic". Typed structurally so
// that currents does not depend on reef; the composition root implements it over the Reef.
export interface MarkdownImporter {
  readonly importDir: (
    request: MarkdownImportRequest,
  ) => Effect.Effect<MarkdownImportReport, MemoryImportError>
}

export interface ObsidianSyncOptions {
  // Absolute path of the vault, from OBSIDIAN_VAULT_PATH.
  readonly vaultPath: string
  readonly importer: MarkdownImporter
}

export const syncObsidian = (
  options: ObsidianSyncOptions,
): Effect.Effect<MarkdownImportReport, ObsidianError | MemoryImportError> => {
  if (!isAbsolute(options.vaultPath)) {
    return Effect.fail(new ObsidianError({ message: "OBSIDIAN_VAULT_PATH must be an absolute path" }))
  }
  return options.importer.importDir({
    dir: options.vaultPath,
    source: OBSIDIAN_SOURCE,
    exclude: OBSIDIAN_EXCLUDED_DIRS,
  })
}
