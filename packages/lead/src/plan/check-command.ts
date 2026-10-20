// The commands a plan may ask the Lead to run as checks. The model writes them, so the Lead accepts only the shapes it
// can reason about, before the Policy is even asked: a package runner, one of four verbs, and a few flags.
const RUNNERS: ReadonlySet<string> = new Set(["pnpm", "npm", "yarn", "bun"])
const VERBS: ReadonlySet<string> = new Set(["test", "lint", "typecheck", "build"])
const FLAGS: ReadonlySet<string> = new Set(["-r", "--recursive", "--silent", "--if-present"])
const FILTER = "--filter"
// A package name or a relative path inside the repo: never absolute, never starting with ".", never with a ".." segment.
const INSIDE_REPO = /^[A-Za-z0-9@_][A-Za-z0-9@_./-]*$/

const inside = (value: string): boolean => INSIDE_REPO.test(value) && !value.split("/").includes("..")

// "test", "lint", "typecheck", "build" or "run <one of them>", for pnpm, npm, yarn and bun. Directory, prefix and config
// flags (-C, --dir, --prefix, --config*, --cwd), "--" and any flag outside the short list are refused, and so is a
// --filter or a positional argument that leaves the repo.
export const checkCommandOk = (argv: ReadonlyArray<string>): boolean => {
  const [runner, ...rest] = argv
  if (runner === undefined || !RUNNERS.has(runner)) return false
  let verb: string | undefined
  let afterRun = false
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i] ?? ""
    if (word === FILTER) {
      const value = rest[i + 1]
      if (value === undefined || !inside(value)) return false
      i++
    } else if (word.startsWith(`${FILTER}=`)) {
      if (!inside(word.slice(FILTER.length + 1))) return false
    } else if (FLAGS.has(word)) {
      // allowed
    } else if (word.startsWith("-")) {
      return false
    } else if (verb !== undefined) {
      if (!inside(word)) return false
    } else if (word === "run" && !afterRun) {
      afterRun = true
    } else if (VERBS.has(word)) {
      verb = word
    } else {
      return false
    }
  }
  return verb !== undefined
}
