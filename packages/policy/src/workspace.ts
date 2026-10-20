import { posix } from "node:path"
import type { ToolCall } from "@shoalwork/contracts"
import { Schema } from "effect"

// Writes are confined to the workspace roots (the cwd or worktree, and the Bot's home in the Tank).
// Outside, or unplaceable, the write asks, even when a rule allows it.
const WRITE_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"])
const WRITE_INPUT = Schema.Struct({
  file_path: Schema.optionalKey(Schema.String),
  notebook_path: Schema.optionalKey(Schema.String),
})

const normalizeRoot = (root: string): string => {
  const normalized = posix.normalize(root.toLowerCase())
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized
}

// roots[0] anchors relative paths. With no roots, only relative paths without ".." can be placed; the rest asks.
export const isWriteOutsideWorkspace = (call: ToolCall, roots: ReadonlyArray<string>): boolean => {
  if (!WRITE_TOOLS.has(call.tool)) {
    return false
  }
  if (!Schema.is(WRITE_INPUT)(call.input)) {
    return true
  }
  const target = call.input.file_path ?? call.input.notebook_path
  if (target === undefined) {
    return true
  }
  const first = roots[0]
  if (first === undefined) {
    return posix.isAbsolute(target) || target.split("/").includes("..")
  }
  const absolute = posix.isAbsolute(target) ? target : posix.join(first, target)
  const resolved = posix.normalize(absolute.toLowerCase())
  return !roots.some((root) => {
    const base = normalizeRoot(root)
    return resolved === base || resolved.startsWith(base === "/" ? "/" : `${base}/`)
  })
}
