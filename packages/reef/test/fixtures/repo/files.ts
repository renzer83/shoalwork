import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

// The fixture repo is built in a temp dir at test time: secret-shaped strings are assembled from pieces so the
// source tree itself stays clean for the secret scan, and the walker needs a real git work tree anyway.

export const APP_TS = [
  'import { x } from "y"',
  "",
  "export function alpha(a: number) {",
  "  return a + 1",
  "}",
  "",
  "export const beta = (b: string) => {",
  "  return b",
  "}",
  "",
  "export class Gamma {",
  "  run() {}",
  "}",
  "",
].join("\n")

export const UTIL_PY = [
  "import os",
  "",
  "def load(path):",
  "    return path",
  "",
  "async def fetch_all():",
  "    return []",
  "",
  "class Store:",
  "    pass",
  "",
].join("\n")

export const LIB_RS = [
  "use std::fmt;",
  "",
  "pub fn compute(x: u32) -> u32 {",
  "    x * 2",
  "}",
  "",
  "pub struct Point {",
  "    x: u32,",
  "}",
  "",
  "impl Point {",
  "    fn new() -> Self { Point { x: 0 } }",
  "}",
  "",
].join("\n")

// 70 lines, no symbol patterns: windows 1-60 and 51-70.
export const NOTES_MD = `${Array.from({ length: 70 }, (_, index) => `note line ${index + 1}`).join("\n")}\n`

export const CORE_FILES: Readonly<Record<string, string | Uint8Array>> = {
  "src/app.ts": APP_TS,
  "tools/util.py": UTIL_PY,
  "src/lib.rs": LIB_RS,
  "notes.md": NOTES_MD,
  "assets/blob.bin": Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]),
  "big.ts": "// filler line to pad the file\n".repeat(10_000),
}

const fakeToken = (): string => ["sk", "ant", "x".repeat(40)].join("-")
const fakeKeyBlock = (): string =>
  `${"-----BEGIN"} ${"RSA PRIVATE"} KEY-----\nMIIEfake\n${"-----END"} ${"RSA PRIVATE"} KEY-----\n`

// Files the walker must never hand to the indexer.
export const EXCLUDED_FILES: Readonly<Record<string, string>> = {
  ".env": "API_URL=http://localhost\n",
  ".env.local": "DEBUG=1\n",
  "keys/server.pem": "not really a key\n",
  id_rsa: "not really a key\n",
  "id_ed25519.pub": "not really a key\n",
  "config/leak.ts": `export const token = "${fakeToken()}"\n`,
  "config/pk.ts": `export const pk = \`${fakeKeyBlock()}\`\n`,
  "pnpm-lock.yaml": "lockfileVersion: 9\n",
  "dist/out.js": "export const built = 1\n",
  "vendor/app.min.js": "export const minified = 1\n",
  "ignored.log": "log line\n",
  "build-out/generated.ts": "export const generated = 1\n",
}

export const GITIGNORE = "*.log\nbuild-out/\n"
export const OUTSIDE_FILE = "export const outside = 1\n"

export const INDEXABLE_PATHS = [".gitignore", "notes.md", "src/app.ts", "src/lib.rs", "tools/util.py"]

const write = (root: string, path: string, content: string | Uint8Array): void => {
  const absolute = join(root, path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, content)
}

const git = (cwd: string, ...args: Array<string>): void => {
  execFileSync("git", args, { cwd, stdio: "ignore" })
}

export interface FixtureRepo {
  readonly dir: string
  readonly outside: string
  readonly cleanup: () => void
}

export const createFixtureRepo = (extra: Readonly<Record<string, string>> = {}): FixtureRepo => {
  const base = mkdtempSync(join(tmpdir(), "shoalwork-indexer-"))
  const dir = join(base, "repo")
  const outside = join(base, "outside.ts")
  mkdirSync(dir)
  writeFileSync(outside, OUTSIDE_FILE)
  git(dir, "init", "-q")
  write(dir, ".gitignore", GITIGNORE)
  for (const [path, content] of Object.entries({ ...CORE_FILES, ...EXCLUDED_FILES, ...extra })) {
    write(dir, path, content)
  }
  symlinkSync(outside, join(dir, "link-out.ts"))
  // Links that stay inside the repo but point at secrets, and a loop.
  symlinkSync(".env", join(dir, "notes.txt"))
  symlinkSync(".git/config", join(dir, "gitcfg.txt"))
  symlinkSync("loop-b", join(dir, "loop-a"))
  symlinkSync("loop-a", join(dir, "loop-b"))
  git(dir, "add", "-A")
  return { dir, outside, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

export const writeInRepo = (repo: FixtureRepo, path: string, content: string): void => {
  write(repo.dir, path, content)
}

export const removeFromRepo = (repo: FixtureRepo, path: string): void => {
  rmSync(join(repo.dir, path), { force: true })
}
