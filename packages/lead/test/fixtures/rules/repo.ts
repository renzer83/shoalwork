// The rules files of a fake repo, as text. They are strings, not files: the repo carries code only (R1), and the
// rules-file names are what the selection reads.
export const CLAUDE_MD = [
  "Intro text before any heading.",
  "# Overview",
  "This repository runs the scalping bot.",
  "## Commands",
  "Run pnpm test before you finish.",
  "## Code style",
  "Use two spaces and named exports.",
  "## Parameterize queries",
  "Parameterize every database query with bound values.",
  "## Testing",
  "Each module has a vitest file beside it.",
  "## Commits",
  "Write conventional commits in English.",
  "## Deployment",
  "Deploys go through the canary pipeline.",
  "## Always",
  "Answer in the language of the project.",
].join("\n")

// A path-scoped rule (Claude Code `paths:`): it applies only to the files under src/db.
export const DB_RULE = [
  "---",
  'paths: ["src/db/**"]',
  "---",
  "# Database",
  "Build the query with the query builder, never with raw SQL strings.",
].join("\n")

export const CURSOR_RULES = "# Style\nPrefer small functions over classes.\n"

export const REPO_FILES: Readonly<Record<string, string>> = {
  "CLAUDE.md": CLAUDE_MD,
  ".claude/rules/db.md": DB_RULE,
  ".cursorrules": CURSOR_RULES,
}
