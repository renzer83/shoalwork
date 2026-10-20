import * as acp from "@agentclientprotocol/sdk"
import type { RunningProcess } from "@shoalwork/tank"
import { type Cause, Effect, Queue, Stream } from "effect"

export type PromptCall = acp.AgentRequestContext<acp.PromptRequest>

export type FakeAgentOptions = {
  // Advertised in the initialize response.
  readonly loadSession?: boolean
  readonly sessionId?: string
  // History replayed (as agent_message_chunk) while a session loads.
  readonly replay?: ReadonlyArray<string>
  // The agent's turn: sends updates / requests, then answers the prompt.
  readonly onPrompt: (call: PromptCall) => Promise<acp.PromptResponse>
  // An update sent for this session before session/new answers (not live yet: it must be dropped).
  readonly chatterOnNew?: boolean
  // When set, session/new fails with this error (e.g. auth required).
  readonly newSessionError?: acp.RequestError
}

export type FakeAgent = {
  readonly proc: RunningProcess
  readonly seen: Array<{ readonly method: string; readonly params: unknown }>
  readonly state: { killed: number; stdinClosed: boolean }
}

export const update = (call: PromptCall, sessionUpdate: acp.SessionUpdate): Promise<void> =>
  call.client.notify(acp.methods.client.session.update, {
    sessionId: call.params.sessionId,
    update: sessionUpdate,
  })

export const text = (value: string): acp.SessionUpdate => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text: value },
})

// An ACP agent served in-process and shaped as a Tank process: stdout lines in, stdin writes out.
export const startFakeAgent = (options: FakeAgentOptions): Effect.Effect<FakeAgent> =>
  Effect.gen(function* () {
    const seen: FakeAgent["seen"] = []
    const state = { killed: 0, stdinClosed: false }
    const toAgent = new TransformStream<Uint8Array, Uint8Array>()
    const fromAgent = new TransformStream<Uint8Array, Uint8Array>()
    const sessionId = options.sessionId ?? "sess-1"

    const app = acp
      .agent({ name: "fake-agent" })
      .onRequest(acp.methods.agent.initialize, (call) => {
        seen.push({ method: "initialize", params: call.params })
        return {
          protocolVersion: acp.PROTOCOL_VERSION,
          agentCapabilities: { loadSession: options.loadSession ?? true },
        }
      })
      .onRequest(acp.methods.agent.session.new, (call) => {
        seen.push({ method: "session/new", params: call.params })
        if (options.newSessionError !== undefined) throw options.newSessionError
        if (options.chatterOnNew !== true) return { sessionId }
        return call.client
          .notify(acp.methods.client.session.update, { sessionId, update: text("EARLY") })
          .then(() => ({ sessionId }))
      })
      .onRequest(acp.methods.agent.session.load, async (call) => {
        seen.push({ method: "session/load", params: call.params })
        for (const line of options.replay ?? []) {
          await call.client.notify(acp.methods.client.session.update, {
            sessionId: call.params.sessionId,
            update: text(line),
          })
        }
        return {}
      })
      .onRequest(acp.methods.agent.session.prompt, (call) => {
        seen.push({ method: "session/prompt", params: call.params })
        return options.onPrompt(call)
      })
    app.connect(acp.ndJsonStream(fromAgent.writable, toAgent.readable))

    const out = yield* Queue.unbounded<string, Cause.Done>()
    const decoder = new TextDecoder()
    const pump = async (): Promise<void> => {
      const reader = fromAgent.readable.getReader()
      let buffer = ""
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        for (let at = buffer.indexOf("\n"); at !== -1; at = buffer.indexOf("\n")) {
          Queue.offerUnsafe(out, buffer.slice(0, at))
          buffer = buffer.slice(at + 1)
        }
      }
      Queue.endUnsafe(out)
    }
    void pump().catch(() => Queue.endUnsafe(out))

    const writer = toAgent.writable.getWriter()
    const encoder = new TextEncoder()
    const proc: RunningProcess = {
      pid: 4242,
      stdout: Stream.fromQueue(out),
      stderr: Stream.empty,
      exitCode: Effect.sync(() => (state.killed > 0 ? 143 : 0)),
      writeStdin: (s) => Effect.promise(() => writer.write(encoder.encode(s)).catch(() => undefined)),
      closeStdin: () =>
        Effect.sync(() => {
          state.stdinClosed = true
        }),
      kill: () =>
        Effect.sync(() => {
          state.killed += 1
          void writer.close().catch(() => undefined)
          Queue.endUnsafe(out)
        }),
    }
    return { proc, seen, state }
  })
