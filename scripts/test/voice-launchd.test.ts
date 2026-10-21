import { describe, expect, it } from "vitest"
import {
  parseVoiceArgs,
  renderVoicePlist,
  type VoiceUnitInput,
  voiceInstallCommands,
} from "../voice-launchd.js"

const input: VoiceUnitInput = {
  nodePath: "/opt/node/bin/node",
  repoRoot: "/srv/shoalwork",
  home: "/Users/bot",
}

describe("renderVoicePlist", () => {
  it("runs the built voice entrypoint with the repo .env, from the repo root", () => {
    const plist = renderVoicePlist(input)
    expect(plist).toContain("<string>com.app.voice</string>")
    expect(plist).toContain("<string>/opt/node/bin/node</string>")
    expect(plist).toContain("<string>--env-file-if-exists=/srv/shoalwork/.env</string>")
    expect(plist).toContain("<string>/srv/shoalwork/services/voice/dist/main.js</string>")
    expect(plist).toContain("<key>WorkingDirectory</key><string>/srv/shoalwork</string>")
    expect(plist).toContain("<key>SuccessfulExit</key>")
  })

  it("writes logs under the user Library and escapes XML in paths", () => {
    const plist = renderVoicePlist({ ...input, repoRoot: "/srv/a&b" })
    expect(plist).toContain("<string>/Users/bot/Library/Logs/voice/voice.out.log</string>")
    expect(plist).toContain("<string>--env-file-if-exists=/srv/a&amp;b/.env</string>")
  })
})

describe("parseVoiceArgs", () => {
  it("resolves --out and rejects a missing or unknown flag", () => {
    expect(parseVoiceArgs(["--out", "/tmp/x"])).toEqual({ outDir: "/tmp/x" })
    expect(parseVoiceArgs([])).toMatch(/missing --out/)
    expect(parseVoiceArgs(["--out", "/tmp/x", "--load"])).toMatch(/--load/)
  })
})

describe("voiceInstallCommands", () => {
  it("prints the copy and bootstrap steps without running them", () => {
    const commands = voiceInstallCommands("/tmp/x/com.app.voice.plist", "/Users/bot")
    expect(commands).toEqual([
      "mkdir -p /Users/bot/Library/Logs/voice /Users/bot/Library/LaunchAgents",
      "cp /tmp/x/com.app.voice.plist /Users/bot/Library/LaunchAgents/com.app.voice.plist",
      "launchctl bootstrap gui/$(id -u) /Users/bot/Library/LaunchAgents/com.app.voice.plist",
    ])
  })
})
