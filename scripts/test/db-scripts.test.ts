import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { backupDatabase } from "../db-backup.js"
import { resetDatabase } from "../db-reset.js"

const repoRoot = fileURLToPath(new URL("../..", import.meta.url))
const scriptPath = (name: string): string => fileURLToPath(new URL(`../${name}`, import.meta.url))

let workDir = ""
let dbPath = ""

const createDatabase = (path: string): void => {
  const db = new DatabaseSync(path)
  db.exec("CREATE TABLE bots (id TEXT PRIMARY KEY); INSERT INTO bots (id) VALUES ('bot_1');")
  db.close()
}

const runScript = (name: string, input: string, args: ReadonlyArray<string> = []) =>
  spawnSync(process.execPath, ["--import", "tsx", scriptPath(name), ...args], {
    cwd: repoRoot,
    input,
    encoding: "utf8",
    env: { ...process.env, DATABASE_PATH: dbPath },
  })

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "shoalwork-db-scripts-"))
  dbPath = join(workDir, "shoalwork.db")
  createDatabase(dbPath)
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe("db:backup", () => {
  it("writes a valid backup file that opens and answers SELECT 1", () => {
    const target = backupDatabase(dbPath, new Date("2026-10-19T18:00:00.000Z"))

    expect(target).toBe(join(workDir, "backups", "shoalwork-2026-10-19T18-00-00.000Z.db"))
    expect(existsSync(target)).toBe(true)
    const backup = new DatabaseSync(target)
    try {
      expect(backup.prepare("SELECT 1 AS x").all()).toEqual([{ x: 1 }])
      expect(backup.prepare("SELECT id FROM bots").all()).toEqual([{ id: "bot_1" }])
    } finally {
      backup.close()
    }
  })

  it("refuses to overwrite an existing backup with the same timestamp", () => {
    const now = new Date("2026-10-19T18:00:00.000Z")
    backupDatabase(dbPath, now)

    expect(() => backupDatabase(dbPath, now)).toThrow(/refusing to overwrite/)
  })

  it("creates the data dir and an empty database when none exists yet", () => {
    const freshDir = join(workDir, "fresh", "data")
    const freshDb = join(freshDir, "shoalwork.db")

    const target = backupDatabase(freshDb, new Date("2026-10-19T18:00:00.000Z"))

    expect(existsSync(freshDb)).toBe(true)
    const backup = new DatabaseSync(target)
    try {
      expect(backup.prepare("SELECT 1 AS x").all()).toEqual([{ x: 1 }])
    } finally {
      backup.close()
    }
  })
})

describe("db:reset", () => {
  it("deletes the database and its -wal, -shm and -journal companions", () => {
    writeFileSync(`${dbPath}-wal`, "")
    writeFileSync(`${dbPath}-shm`, "")

    const removed = resetDatabase(dbPath)

    expect(removed).toEqual([dbPath, `${dbPath}-wal`, `${dbPath}-shm`])
    expect(existsSync(dbPath)).toBe(false)
    expect(existsSync(`${dbPath}-wal`)).toBe(false)
    expect(existsSync(`${dbPath}-shm`)).toBe(false)
  })

  it("refuses to run without --yes and keeps the database", () => {
    const result = runScript("db-reset.ts", "")

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/pass --yes/)
    expect(existsSync(dbPath)).toBe(true)
  })

  it("deletes the database when run with --yes", () => {
    const result = runScript("db-reset.ts", "", ["--yes"])

    expect(result.status).toBe(0)
    expect(existsSync(dbPath)).toBe(false)
  })
})

describe("db:shell", () => {
  it("answers SELECT 1 AS x with a JSON array of rows", () => {
    const result = runScript("db-shell.ts", "SELECT 1 AS x\n")

    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('[{"x":1}]')
  })

  it("reports failed statements on stderr and exits 1", () => {
    const result = runScript("db-shell.ts", "SELECT * FROM nope\n")

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/error:/)
  })
})
