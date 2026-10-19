// Deletes the SQLite database file and its WAL/SHM/journal companions. Requires --yes.
import { existsSync, rmSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { resolveDatabasePath } from "./db-backup.js"

export const resetDatabase = (dbPath: string): ReadonlyArray<string> => {
  const removed: Array<string> = []
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) {
    if (existsSync(file)) {
      rmSync(file)
      removed.push(file)
    }
  }
  return removed
}

const isEntrypoint = (metaUrl: string): boolean =>
  process.argv[1] !== undefined && metaUrl === pathToFileURL(resolve(process.argv[1])).href

if (isEntrypoint(import.meta.url)) {
  if (!process.argv.includes("--yes")) {
    process.stderr.write("db:reset refused: pass --yes to confirm deleting the database\n")
    process.exitCode = 1
  } else {
    const dbPath = resolveDatabasePath()
    const removed = resetDatabase(dbPath)
    if (removed.length === 0) {
      process.stdout.write(`nothing to remove at ${dbPath}\n`)
    } else {
      for (const file of removed) {
        process.stdout.write(`removed ${file}\n`)
      }
    }
  }
}
