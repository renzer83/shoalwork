// Maps a source secrets file (outside the repo) to Bot scopes and prints a report with keys and scopes only —
// never the secret values (R7). Usage: pnpm tsx scripts/vault-import.ts --from <file> --map config/secrets-map.yaml
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"

const SCOPES: ReadonlySet<string> = new Set(["bot", "global"])

// Flat key -> scope map: one `key: scope` per line; `#` comments and blank lines are skipped.
const parseMap = (text: string): Record<string, string> => {
  const map: Record<string, string> = {}
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim()
    if (line === "" || line.startsWith("#")) continue
    const colon = line.indexOf(":")
    if (colon <= 0) throw new Error(`invalid map line: ${rawLine}`)
    const key = line.slice(0, colon).trim()
    const scope = line.slice(colon + 1).trim()
    if (!SCOPES.has(scope)) throw new Error(`unknown scope "${scope}" for ${key}`)
    map[key] = scope
  }
  return map
}

const mapSecrets = (
  source: Record<string, unknown>,
  map: Record<string, string>,
): { mapped: ReadonlyArray<readonly [string, string]>; unmapped: ReadonlyArray<string> } => {
  const mapped: Array<readonly [string, string]> = []
  const unmapped: Array<string> = []
  for (const key of Object.keys(source).sort()) {
    const scope = map[key]
    if (scope === undefined) unmapped.push(key)
    else mapped.push([key, scope])
  }
  return { mapped, unmapped }
}

const formatReport = (result: {
  mapped: ReadonlyArray<readonly [string, string]>
  unmapped: ReadonlyArray<string>
}): string => {
  const lines = [
    "# Vault import report",
    `mapped: ${result.mapped.length}`,
    `unmapped: ${result.unmapped.length}`,
  ]
  for (const [key, scope] of result.mapped) lines.push(`${key}: ${scope}`)
  if (result.unmapped.length > 0) {
    lines.push("", "# unmapped keys:")
    for (const key of result.unmapped) lines.push(`# ${key}`)
  }
  return lines.join("\n")
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isEntrypoint = (metaUrl: string): boolean =>
  process.argv[1] !== undefined && metaUrl === pathToFileURL(resolve(process.argv[1])).href

if (isEntrypoint(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: {
        from: { type: "string" },
        map: { type: "string" },
      },
    })
    if (values.from === undefined || values.map === undefined) {
      throw new Error("usage: vault-import --from <file> --map <file>")
    }
    const source: unknown = JSON.parse(readFileSync(values.from, "utf8"))
    if (!isRecord(source)) throw new Error(`source is not a JSON object: ${values.from}`)
    const map = parseMap(readFileSync(values.map, "utf8"))
    process.stdout.write(`${formatReport(mapSecrets(source, map))}\n`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`vault-import failed: ${message}\n`)
    process.exitCode = 1
  }
}
