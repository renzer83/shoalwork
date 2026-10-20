// Generates the user-level service unit of the core: systemd (Linux) or launchd (macOS).
// Writes the file into --out and prints the install commands. It never installs or loads the unit.
// Usage: pnpm deploy:unit --target systemd|launchd --out <dir>
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { parseArgs } from "node:util"

export const UNIT_NAME = "shoalwork-core"
export const LAUNCHD_LABEL = "dev.shoalwork.core"
export const TARGETS = ["systemd", "launchd"] as const
export type Target = (typeof TARGETS)[number]

export interface UnitInput {
  // Absolute path of the Node binary that runs the core.
  readonly nodePath: string
  // Absolute path of the repo root: WorkingDirectory, and where .env lives.
  readonly repoRoot: string
  // Absolute home of the user who runs the core: launchd does not expand `~`.
  readonly home: string
}

export interface DeployArgs {
  readonly target: Target
  readonly outDir: string
}

const usage = "usage: pnpm deploy:unit --target systemd|launchd --out <dir>"

// Pure: returns the parsed arguments or the first problem found.
export const parseDeployArgs = (argv: ReadonlyArray<string>): DeployArgs | string => {
  let values: { readonly target?: string | undefined; readonly out?: string | undefined }
  try {
    values = parseArgs({
      args: [...argv],
      options: { target: { type: "string" }, out: { type: "string" } },
      strict: true,
    }).values
  } catch (cause) {
    return cause instanceof Error ? cause.message : "invalid arguments"
  }
  if (values.target === undefined) return `missing --target systemd|launchd (${usage})`
  const target = TARGETS.find((known) => known === values.target)
  if (target === undefined) {
    return `--target must be systemd or launchd, got "${values.target}"`
  }
  if (values.out === undefined || values.out.trim() === "") return `missing --out <dir> (${usage})`
  return { target, outDir: resolve(values.out) }
}

// PATH for the core's children: claude and codex are usually in ~/.local/bin or Homebrew.
export const unitPath = (home: string): string =>
  [join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":")

export const coreEntry = (repoRoot: string): string => join(repoRoot, "services", "core", "dist", "main.js")

export const envFile = (repoRoot: string): string => join(repoRoot, ".env")

// systemd: `%` is a specifier and `$` an env expansion; ExecStart words are split on whitespace.
const systemdValue = (value: string): string => value.replaceAll("%", "%%")

const systemdWord = (value: string): string => {
  const escaped = systemdValue(value).replaceAll("$", "$$")
  if (!/[\s"\\]/.test(escaped)) return escaped
  return `"${escaped.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

export const renderSystemdUnit = (input: UnitInput): string =>
  [
    "[Unit]",
    "Description=Shoalwork core (bot orchestrator)",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=exec",
    `WorkingDirectory=${systemdValue(input.repoRoot)}`,
    `EnvironmentFile=-${systemdValue(envFile(input.repoRoot))}`,
    `Environment="PATH=${systemdValue(unitPath(input.home)).replaceAll('"', '\\"')}"`,
    `ExecStart=${[
      systemdWord(input.nodePath),
      systemdWord(`--env-file-if-exists=${envFile(input.repoRoot)}`),
      systemdWord(coreEntry(input.repoRoot)),
    ].join(" ")}`,
    "Restart=on-failure",
    "RestartSec=5",
    // Stop the main process first, then the whole group: executor children must not outlive the core.
    "KillMode=mixed",
    "TimeoutStopSec=30",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n")

const xml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")

const xmlString = (value: string): string => `<string>${xml(value)}</string>`

export const launchdLogDir = (home: string): string => join(home, "Library", "Logs", UNIT_NAME)

export const renderLaunchdPlist = (input: UnitInput): string => {
  const logDir = launchdLogDir(input.home)
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key>${xmlString(LAUNCHD_LABEL)}`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    ${xmlString(input.nodePath)}`,
    `    ${xmlString(`--env-file-if-exists=${envFile(input.repoRoot)}`)}`,
    `    ${xmlString(coreEntry(input.repoRoot))}`,
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
    `    ${xmlString(unitPath(input.home))}`,
    "  </dict>",
    "  <key>StandardOutPath</key>",
    `  ${xmlString(join(logDir, "core.out.log"))}`,
    "  <key>StandardErrorPath</key>",
    `  ${xmlString(join(logDir, "core.err.log"))}`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n")
}

export const unitFileName = (target: Target): string =>
  target === "systemd" ? `${UNIT_NAME}.service` : `${LAUNCHD_LABEL}.plist`

const shellWord = (value: string): string =>
  /^[A-Za-z0-9_/.:@%+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`

// Commands printed for Renan. Nothing here is executed by this script.
export const installCommands = (target: Target, filePath: string, home: string): ReadonlyArray<string> => {
  if (target === "systemd") {
    const installed = join(home, ".config", "systemd", "user", `${UNIT_NAME}.service`)
    return [
      `mkdir -p ${shellWord(dirname(installed))}`,
      `cp ${shellWord(filePath)} ${shellWord(installed)}`,
      "loginctl enable-linger $USER",
      "systemctl --user daemon-reload",
      `systemctl --user enable --now ${UNIT_NAME}`,
    ]
  }
  const installed = join(home, "Library", "LaunchAgents", unitFileName("launchd"))
  return [
    `mkdir -p ${shellWord(launchdLogDir(home))} ${shellWord(dirname(installed))}`,
    `cp ${shellWord(filePath)} ${shellWord(installed)}`,
    `launchctl bootstrap gui/$(id -u) ${shellWord(installed)}`,
  ]
}

const renderFor = (target: Target, input: UnitInput): string =>
  target === "systemd" ? renderSystemdUnit(input) : renderLaunchdPlist(input)

const isEntrypoint = (metaUrl: string): boolean =>
  process.argv[1] !== undefined && metaUrl === pathToFileURL(resolve(process.argv[1])).href

const main = (): void => {
  const parsed = parseDeployArgs(process.argv.slice(2))
  if (typeof parsed === "string") {
    process.stderr.write(`deploy:unit: ${parsed}\n`)
    process.exitCode = 2
    return
  }
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
  const input: UnitInput = { nodePath: process.execPath, repoRoot, home: homedir() }
  try {
    mkdirSync(parsed.outDir, { recursive: true })
    const filePath = join(parsed.outDir, unitFileName(parsed.target))
    writeFileSync(filePath, renderFor(parsed.target, input))
    process.stdout.write(`written: ${filePath}\n`)
    if (!existsSync(coreEntry(repoRoot))) {
      process.stdout.write(
        `WARNING: ${coreEntry(repoRoot)} does not exist; run pnpm build before starting the unit\n`,
      )
    }
    process.stdout.write("\ninstall (run yourself):\n")
    for (const command of installCommands(parsed.target, filePath, input.home)) {
      process.stdout.write(`  ${command}\n`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`deploy:unit failed: ${message}\n`)
    process.exitCode = 1
  }
}

if (isEntrypoint(import.meta.url)) {
  main()
}
