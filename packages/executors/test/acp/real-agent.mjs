// An ACP agent over real stdio, for the transport test: argv = [pidFile, mode]. mode "ask" requests a permission and
// then hangs. Session creation starts a grandchild in the same process group and records its pid.
import { spawn } from "node:child_process"
import { writeFileSync } from "node:fs"
import { Readable, Writable } from "node:stream"
import * as acp from "@agentclientprotocol/sdk"

const [pidFile, mode] = process.argv.slice(2)

acp
  .agent({ name: "real-agent" })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: {},
  }))
  .onRequest(acp.methods.agent.session.new, () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
    writeFileSync(pidFile, String(child.pid))
    return { sessionId: "real-1" }
  })
  .onRequest(acp.methods.agent.session.prompt, async (call) => {
    await call.client.notify(acp.methods.client.session.update, {
      sessionId: call.params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "real-pong" } },
    })
    if (mode === "ask") {
      await call.client.request(acp.methods.client.session.requestPermission, {
        sessionId: call.params.sessionId,
        toolCall: { toolCallId: "t", kind: "execute", title: "run", rawInput: { command: "make deploy" } },
        options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }],
      })
      await new Promise(() => undefined)
    }
    return { stopReason: "end_turn" }
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
