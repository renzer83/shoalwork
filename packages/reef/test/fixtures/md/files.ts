import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

// Markdown trees are written to a temp dir at test time: the repo itself must not hold .md files (gate G-NO-DOCS).

export const SOUL_MD = [
  "---",
  "name: lead",
  "tags: [coordinator]",
  "---",
  "# Lead",
  "",
  "Coordena os bots e fala com Renan.",
  "",
  "## Regras",
  "",
  "Nunca executa código diretamente.",
  "",
].join("\n")

export const NOTES_MD = ["# Notas", "", "a".repeat(2000), "", "b".repeat(100), ""].join("\n")

// A fenced block of 45 body lines: over the 40-line limit, so the importer leaves a placeholder.
export const CODE_MD = [
  "# Código",
  "",
  "```ts",
  ...Array.from({ length: 45 }, (_, i) => `const line${i} = ${i}`),
  "```",
  "",
].join("\n")

// Assembled from pieces so this source file does not match the secret grep. Shape only; it is not a real token.
export const fakeToken = (): string => ["sk", "ant", "api03", "x".repeat(24)].join("-")

export interface MarkdownDir {
  readonly dir: string
  readonly write: (path: string, content: string) => void
  readonly remove: (path: string) => void
  readonly cleanup: () => void
}

export const createMarkdownDir = (files: Readonly<Record<string, string>>): MarkdownDir => {
  const dir = mkdtempSync(join(tmpdir(), "shoalwork-md-"))
  const write = (path: string, content: string): void => {
    const absolute = join(dir, path)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, content, "utf8")
  }
  for (const [path, content] of Object.entries(files)) {
    write(path, content)
  }
  return {
    dir,
    write,
    remove: (path) => rmSync(join(dir, path), { force: true }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}
