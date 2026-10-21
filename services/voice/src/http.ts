import { timingSafeEqual } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { VoiceError } from "@shoalwork/contracts"
import { Effect, Schema, type Scope } from "effect"
import type { ManualSource, TriggerShape } from "./wake/triggers.js"

// Loopback only, fixed port (02-architecture §19 neighbours: STT 28921, TTS 28922).
export const TRIGGER_PORT = 28920
const HOST = "127.0.0.1"
export const TRIGGER_BODY_LIMIT_BYTES = 1_024

export const PttBody = Schema.Struct({ pressed: Schema.Boolean })
const decodePttBody = Schema.decodeUnknownEffect(PttBody)

export type TriggerServer = {
  readonly port: number
}

// Constant-time comparison: a wrong token must not be guessable byte by byte.
export const bearerMatches = (header: string | undefined, token: string): boolean => {
  const prefix = "Bearer "
  if (token.length === 0 || header === undefined || !header.startsWith(prefix)) return false
  const given = Buffer.from(header.slice(prefix.length), "utf8")
  const expected = Buffer.from(token, "utf8")
  return given.length === expected.length && timingSafeEqual(given, expected)
}

const reply = (res: ServerResponse, status: number, body: Record<string, unknown>): void => {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

// The body as text, or null when it is over the limit (the rest is drained, not stored).
const readBody = (req: IncomingMessage): Promise<string | null> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > TRIGGER_BODY_LIMIT_BYTES) tooLarge = true
      else chunks.push(chunk)
    })
    req.on("end", () => resolve(tooLarge ? null : Buffer.concat(chunks).toString("utf8")))
    req.on("error", () => resolve(null))
  })

// `pressed` of a valid body, undefined for anything else.
const parsePttBody = (raw: string): Effect.Effect<boolean | undefined> =>
  Effect.try({ try: (): unknown => JSON.parse(raw), catch: () => undefined }).pipe(
    Effect.flatMap((json) => decodePttBody(json)),
    Effect.map((body) => body.pressed),
    Effect.orElseSucceed(() => undefined),
  )

const acceptedReply = (res: ServerResponse, accepted: boolean): void =>
  accepted
    ? reply(res, 202, { accepted: true })
    : reply(res, 409, { accepted: false, error: "source disabled by VOICE_TRIGGER" })

const handle = async (
  trigger: TriggerShape,
  token: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> => {
  if (!bearerMatches(req.headers.authorization, token)) return reply(res, 401, { error: "unauthorized" })
  const path = new URL(req.url ?? "/", `http://${HOST}`).pathname
  if (path !== "/voice/wake" && path !== "/voice/ptt") return reply(res, 404, { error: "not found" })
  if (req.method !== "POST") return reply(res, 405, { error: "method not allowed" })

  if (path === "/voice/wake") {
    req.resume()
    const accepted = await Effect.runPromise(trigger.accept("hotkey"))
    return acceptedReply(res, accepted)
  }

  const raw = await readBody(req)
  if (raw === null) return reply(res, 413, { error: "body too large" })
  const pressed = await Effect.runPromise(parsePttBody(raw))
  if (pressed === undefined) return reply(res, 400, { error: 'body must be {"pressed": boolean}' })
  const source: ManualSource = pressed ? "ptt_down" : "ptt_up"
  return acceptedReply(res, await Effect.runPromise(trigger.accept(source)))
}

// Starts the loopback server for the trigger routes, released (closed) with the scope.
// `port: 0` asks the OS for a free port, which the result reports.
export const serveTriggers = (
  trigger: TriggerShape,
  options: { readonly token: string; readonly port?: number },
): Effect.Effect<TriggerServer, VoiceError, Scope.Scope> =>
  Effect.gen(function* () {
    if (options.token.length === 0)
      return yield* Effect.fail(new VoiceError({ op: "start", reason: "VOICE_TRIGGER_TOKEN is not set" }))
    const port = options.port ?? TRIGGER_PORT
    const listening = Effect.callback<{ readonly server: Server; readonly port: number }, VoiceError>(
      (resume) => {
        const server = createServer((req, res) => {
          handle(trigger, options.token, req, res).catch(() => {
            if (!res.headersSent) reply(res, 500, { error: "internal error" })
          })
        })
        server.once("error", () =>
          resume(Effect.fail(new VoiceError({ op: "start", reason: `port ${port} unavailable` }))),
        )
        server.listen(port, HOST, () => {
          // Later errors (after a successful bind) must not crash the process.
          server.removeAllListeners("error")
          server.on("error", () => undefined)
          const address = server.address()
          const boundPort = typeof address === "object" && address !== null ? address.port : port
          resume(Effect.succeed({ server, port: boundPort }))
        })
      },
    )
    const bound = yield* Effect.acquireRelease(listening, ({ server }) =>
      Effect.callback<void>((resume) => {
        server.closeAllConnections()
        server.close(() => resume(Effect.void))
      }),
    )
    return { port: bound.port }
  })
