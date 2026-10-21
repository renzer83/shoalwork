// Generates the launchd agent of the voice service (com.app.voice). Same shape as deploy-unit.ts (T-033):
// writes the plist into --out and prints the install commands. It never installs or loads the agent.
// Usage: tsx scripts/voice-launchd.ts --out <dir>
import { mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { parseArgs } from "node:util"

export const VOICE_LABEL = "com.app.voice"
const LOG_NAME = "voice"

export interface VoiceUnitInput {
  // Absolute path of the Node binary that runs the voice service.
  readonly nodePath: string
  // Absolute path of the repo root: WorkingDirectory, and where .env lives.
  readonly repoRoot: string
  // Absolute home of the user: launchd does not expand `~`.
  readonly home: string
}

export const voiceEntry = (repoRoot: string): string => join(repoRoot, "services", "voice", "dist", "main.js")

export const voiceEnvFile = (repoRoot: string): string => join(repoRoot, ".env")

export const voiceLogDir = (home: string): string => join(home, "Library", "Logs", LOG_NAME)

// claude-style tools and Homebrew binaries are not on launchd's default PATH.
export const voicePath = (home: string): string =>
  [join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":")

const xml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")

const xmlString = (value: string): string => `<string>${xml(value)}</string>`

export const renderVoicePlist = (input: VoiceUnitInput): string => {
  const logDir = voiceLogDir(input.home)
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key>${xmlString(VOICE_LABEL)}`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    ${xmlString(input.nodePath)}`,
    `    ${xmlString(`--env-file-if-exists=${voiceEnvFile(input.repoRoot)}`)}`,
    `    ${xmlString(voiceEntry(input.repoRoot))}`,
    "  </array>",
    `  <key>WorkingDirectory</key>${xmlString(input.repoRoot)}`,
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <dict>",
    "    <key>SuccessfulExit</key>",
    "    <false/>",
    "  </dict>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    "    <key>PATH</key>",
    `    ${xmlString(voicePath(input.home))}`,
    "  </dict>",
    "  <key>StandardOutPath</key>",
    `  ${xmlString(join(logDir, "voice.out.log"))}`,
    "  <key>StandardErrorPath</key>",
    `  ${xmlString(join(logDir, "voice.err.log"))}`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n")
}

export const voicePlistFileName = (): string => `${VOICE_LABEL}.plist`

const shellWord = (value: string): string =>
  /^[A-Za-z0-9_/.:@%+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`

// Printed for the user. Nothing here is executed by this script.
export const voiceInstallCommands = (filePath: string, home: string): ReadonlyArray<string> => {
  const installed = join(home, "Library", "LaunchAgents", voicePlistFileName())
  return [
    `mkdir -p ${shellWord(voiceLogDir(home))} ${shellWord(dirname(installed))}`,
    `cp ${shellWord(filePath)} ${shellWord(installed)}`,
    `launchctl bootstrap gui/$(id -u) ${shellWord(installed)}`,
  ]
}

// Pure: the --out directory resolved to an absolute path, or the first problem found.
export const parseVoiceArgs = (argv: ReadonlyArray<string>): { readonly outDir: string } | string => {
  let values: { readonly out?: string | undefined }
  try {
    values = parseArgs({ args: [...argv], options: { out: { type: "string" } }, strict: true }).values
  } catch (cause) {
    return cause instanceof Error ? cause.message : "invalid arguments"
  }
  if (values.out === undefined || values.out.trim() === "")
    return "missing --out <dir> (usage: tsx scripts/voice-launchd.ts --out <dir>)"
  return { outDir: resolve(values.out) }
}

const isEntrypoint = (metaUrl: string): boolean =>
  process.argv[1] !== undefined && metaUrl === pathToFileURL(resolve(process.argv[1])).href

const main = (): void => {
  const parsed = parseVoiceArgs(process.argv.slice(2))
  if (typeof parsed === "string") {
    process.stderr.write(`voice-launchd: ${parsed}\n`)
    process.exitCode = 2
    return
  }
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
  const input: VoiceUnitInput = { nodePath: process.execPath, repoRoot, home: homedir() }
  try {
    mkdirSync(parsed.outDir, { recursive: true })
    const filePath = join(parsed.outDir, voicePlistFileName())
    writeFileSync(filePath, renderVoicePlist(input))
    process.stdout.write(`written: ${filePath}\n`)
    process.stdout.write("\ninstall (run yourself):\n")
    for (const command of voiceInstallCommands(filePath, input.home)) process.stdout.write(`  ${command}\n`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`voice-launchd failed: ${message}\n`)
    process.exitCode = 1
  }
}

if (isEntrypoint(import.meta.url)) {
  main()
}
