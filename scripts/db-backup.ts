// Consistent backup of the SQLite database with VACUUM INTO. Never overwrites a backup.
import { existsSync, mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { pathToFileURL } from "node:url"

const DEFAULT_DATABASE_PATH = "./data/shoalwork.db"

export const resolveDatabasePath = (env: NodeJS.ProcessEnv = process.env): string => {
  const raw = env.DATABASE_PATH
  return resolve(raw !== undefined && raw.length > 0 ? raw : DEFAULT_DATABASE_PATH)
}

// Same PRAGMAs as the core boot (ADR-001). Applied per connection; WAL persists in the file.
export const applyPragmas = (db: DatabaseSync): void => {
  db.exec(
    "PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL; PRAGMA journal_mode = WAL;",
  )
}

export const backupFileName = (now: Date): string => `shoalwork-${now.toISOString().replaceAll(":", "-")}.db`

// Writes `<dirname(dbPath)>/backups/shoalwork-<ISO>.db` and returns its absolute path.
// Opening a missing database creates it empty (same as the shell), so the dir is created first.
export const backupDatabase = (dbPath: string, now: Date): string => {
  const backupDir = join(dirname(dbPath), "backups")
  mkdirSync(backupDir, { recursive: true })
  const target = join(backupDir, backupFileName(now))
  if (existsSync(target)) {
    throw new Error(`backup already exists, refusing to overwrite: ${target}`)
  }
  const db = new DatabaseSync(dbPath)
  try {
    applyPragmas(db)
    db.prepare("VACUUM INTO ?").run(target)
  } finally {
    db.close()
  }
  return target
}

const isEntrypoint = (metaUrl: string): boolean =>
  process.argv[1] !== undefined && metaUrl === pathToFileURL(resolve(process.argv[1])).href

if (isEntrypoint(import.meta.url)) {
  try {
    const written = backupDatabase(resolveDatabasePath(), new Date())
    process.stdout.write(`${written}\n`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`db:backup failed: ${message}\n`)
    process.exitCode = 1
  }
}
