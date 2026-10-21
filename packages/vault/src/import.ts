import { Data, Effect, Schema } from "effect"

export const SecretScope = Schema.Literals(["bot", "global"])
export type SecretScope = typeof SecretScope.Type

export class SecretMapError extends Data.TaggedError("SecretMapError")<{
  line: string
  reason: string
}> {}

// Flat key -> scope map: one `key: scope` per line; `#` comments and blank lines are skipped. The file names
// keys and scopes only; values stay in the source file outside the repo (R7).
export const parseSecretsMap = (text: string): Effect.Effect<Record<string, SecretScope>, SecretMapError> =>
  Effect.gen(function* () {
    const map: Record<string, SecretScope> = {}
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim()
      if (line === "" || line.startsWith("#")) continue
      const colon = line.indexOf(":")
      if (colon <= 0) {
        return yield* Effect.fail(new SecretMapError({ line: rawLine, reason: "expected `key: scope`" }))
      }
      const key = line.slice(0, colon).trim()
      const scope = line.slice(colon + 1).trim()
      if (scope !== "bot" && scope !== "global") {
        return yield* Effect.fail(new SecretMapError({ line: rawLine, reason: `unknown scope "${scope}"` }))
      }
      map[key] = scope
    }
    return map
  })

export type ImportedSecret = { readonly key: string; readonly scope: SecretScope }

export type ImportResult = {
  readonly mapped: ReadonlyArray<ImportedSecret>
  readonly unmapped: ReadonlyArray<string>
}

// Maps source keys to their scope. A key without a map entry is reported as unmapped, never with its value.
export const importSecrets = (
  source: Readonly<Record<string, unknown>>,
  map: Readonly<Record<string, SecretScope>>,
): ImportResult => {
  const mapped: Array<ImportedSecret> = []
  const unmapped: Array<string> = []
  for (const key of Object.keys(source).sort()) {
    const scope = map[key]
    if (scope === undefined) unmapped.push(key)
    else mapped.push({ key, scope })
  }
  return { mapped, unmapped }
}

// A report that names keys and scopes but never the secret values (R7).
export const formatImportReport = (result: ImportResult): string => {
  const lines = [
    "# Vault import report",
    `mapped: ${result.mapped.length}`,
    `unmapped: ${result.unmapped.length}`,
  ]
  for (const { key, scope } of result.mapped) lines.push(`${key}: ${scope}`)
  if (result.unmapped.length > 0) {
    lines.push("", "# unmapped keys:")
    for (const key of result.unmapped) lines.push(`# ${key}`)
  }
  return lines.join("\n")
}
