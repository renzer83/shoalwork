// Minimal SQL shell. Reads SQL from stdin, one statement per line.
// Row-returning statements print a JSON array of row objects; others print {"changes":n}.
// Errors go to stderr and the exit code is 1 if any line failed.
import { mkdirSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { pathToFileURL } from "node:url"
import { applyPragmas, resolveDatabasePath } from "./db-backup.js"

export const runStatement = (db: DatabaseSync, sql: string): string => {
  const statement = db.prepare(sql)
  if (statement.columns().length > 0) {
    return JSON.stringify(statement.all())
  }
  return JSON.stringify({ changes: statement.run().changes })
}

const isEntrypoint = (metaUrl: string): boolean =>
  process.argv[1] !== undefined && metaUrl === pathToFileURL(resolve(process.argv[1])).href

if (isEntrypoint(import.meta.url)) {
  const dbPath = resolveDatabasePath()
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  let failed = false
  try {
    applyPragmas(db)
    const lines = readFileSync(0, "utf8").split("\n")
    for (const raw of lines) {
      const sql = raw.trim()
      if (sql === "") {
        continue
      }
      try {
        process.stdout.write(`${runStatement(db, sql)}\n`)
      } catch (error) {
        failed = true
        const message = error instanceof Error ? error.message : String(error)
        process.stderr.write(`error: ${message}\n`)
      }
    }
  } finally {
    db.close()
  }
  process.exitCode = failed ? 1 : 0
}
