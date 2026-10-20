import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  installCommands,
  parseDeployArgs,
  renderLaunchdPlist,
  renderSystemdUnit,
  type UnitInput,
  unitPath,
} from "../deploy-unit.js"

const repoRoot = fileURLToPath(new URL("../..", import.meta.url))
const scriptPath = fileURLToPath(new URL("../deploy-unit.ts", import.meta.url))

const input: UnitInput = {
  nodePath: "/opt/node/bin/node",
  repoRoot: "/srv/shoalwork",
  home: "/home/bot",
}

let workDir = ""

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "shoalwork-deploy-unit-"))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe("parseDeployArgs", () => {
  it("accepts systemd and launchd with an --out directory resolved to an absolute path", () => {
    expect(parseDeployArgs(["--target", "systemd", "--out", "units"])).toEqual({
      target: "systemd",
      outDir: join(process.cwd(), "units"),
    })
    expect(parseDeployArgs(["--target", "launchd", "--out", "/tmp/x"])).toEqual({
      target: "launchd",
      outDir: "/tmp/x",
    })
  })

  it("rejects a missing or unknown target", () => {
    expect(parseDeployArgs(["--out", "/tmp/x"])).toMatch(/missing --target/)
    expect(parseDeployArgs(["--target", "windows", "--out", "/tmp/x"])).toMatch(/must be systemd or launchd/)
  })

  it("rejects a missing --out directory", () => {
    expect(parseDeployArgs(["--target", "launchd"])).toMatch(/missing --out/)
    expect(parseDeployArgs(["--target", "launchd", "--out", "  "])).toMatch(/missing --out/)
  })

  it("rejects unknown flags", () => {
    expect(parseDeployArgs(["--target", "launchd", "--out", "/tmp/x", "--install"])).toMatch(/--install/)
  })
})

describe("renderSystemdUnit", () => {
  it("matches the template for a fixed input (user unit, KillMode=mixed, absolute paths)", () => {
    expect(renderSystemdUnit(input)).toBe(
      [
        "[Unit]",
        "Description=Shoalwork core (bot orchestrator)",
        "After=network-online.target",
        "",
        "[Service]",
        "Type=exec",
        "WorkingDirectory=/srv/shoalwork",
        "EnvironmentFile=-/srv/shoalwork/.env",
        'Environment="PATH=/home/bot/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"',
        "ExecStart=/opt/node/bin/node --env-file-if-exists=/srv/shoalwork/.env /srv/shoalwork/services/core/dist/main.js",
        "Restart=on-failure",
        "RestartSec=5",
        "KillMode=mixed",
        "TimeoutStopSec=30",
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
      ].join("\n"),
    )
  })

  it("escapes specifiers and quotes words with spaces so systemd reads them as one argument", () => {
    const unit = renderSystemdUnit({
      nodePath: "/opt/my node/bin/node",
      repoRoot: "/srv/100%/app",
      home: "/home/bot",
    })
    expect(unit).toContain("WorkingDirectory=/srv/100%%/app")
    expect(unit).toContain('ExecStart="/opt/my node/bin/node" --env-file-if-exists=/srv/100%%/app/.env')
  })
})

describe("renderLaunchdPlist", () => {
  it("keeps the core alive on failure only, runs at load, and logs under ~/Library/Logs/<name>", () => {
    const plist = renderLaunchdPlist(input)
    expect(plist).toContain("<key>Label</key><string>dev.shoalwork.core</string>")
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>")
    expect(plist).toContain("<key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>")
    expect(plist).toContain("<string>/home/bot/Library/Logs/shoalwork-core/core.out.log</string>")
    expect(plist).toContain("<string>/home/bot/Library/Logs/shoalwork-core/core.err.log</string>")
    expect(plist).toContain("<string>/srv/shoalwork/services/core/dist/main.js</string>")
  })

  it("puts ~/.local/bin and /opt/homebrew/bin on PATH so claude and codex are found", () => {
    expect(unitPath("/Users/me")).toBe("/Users/me/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")
    expect(renderLaunchdPlist(input)).toContain(`<string>${unitPath("/home/bot")}</string>`)
  })

  it("escapes XML special characters in paths", () => {
    const plist = renderLaunchdPlist({ nodePath: "/a&b/node", repoRoot: "/srv/<x>", home: "/home/bot" })
    expect(plist).toContain("<string>/a&amp;b/node</string>")
    expect(plist).toContain("/srv/&lt;x&gt;/.env")
  })
})

describe("installCommands", () => {
  it("prints the systemd install sequence in order", () => {
    const commands = installCommands("systemd", "/out/shoalwork-core.service", "/home/bot")
    expect(commands.at(-3)).toBe("loginctl enable-linger $USER")
    expect(commands.at(-2)).toBe("systemctl --user daemon-reload")
    expect(commands.at(-1)).toBe("systemctl --user enable --now shoalwork-core")
  })

  it("prints the launchd bootstrap command for the copied plist", () => {
    const commands = installCommands("launchd", "/out/dev.shoalwork.core.plist", "/Users/me")
    expect(commands.at(-1)).toBe(
      "launchctl bootstrap gui/$(id -u) /Users/me/Library/LaunchAgents/dev.shoalwork.core.plist",
    )
  })
})

describe("deploy:unit CLI", () => {
  const runScript = (args: ReadonlyArray<string>) =>
    spawnSync(process.execPath, ["--import", "tsx", scriptPath, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
    })

  it("writes the systemd unit into --out and exits 0", () => {
    const result = runScript(["--target", "systemd", "--out", workDir])
    expect(result.status).toBe(0)
    const unit = readFileSync(join(workDir, "shoalwork-core.service"), "utf8")
    expect(unit).toContain("KillMode=mixed")
    expect(unit).toContain("ExecStart=")
  })

  it("writes the launchd plist into --out and exits 0", () => {
    const result = runScript(["--target", "launchd", "--out", workDir])
    expect(result.status).toBe(0)
    expect(existsSync(join(workDir, "dev.shoalwork.core.plist"))).toBe(true)
    expect(readFileSync(join(workDir, "dev.shoalwork.core.plist"), "utf8")).toContain("<key>KeepAlive</key>")
  })

  it("exits 2 without writing when --out is missing", () => {
    const result = runScript(["--target", "launchd"])
    expect(result.status).toBe(2)
    expect(result.stderr).toMatch(/missing --out/)
  })
})
