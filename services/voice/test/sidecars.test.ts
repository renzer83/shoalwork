import { EventEmitter } from "node:events"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { type TranscribeRequest, VoiceError } from "@shoalwork/contracts"
import { Effect, Exit, Option, Stream } from "effect"
import { describe, expect } from "vitest"
import type { VoiceConfigShape } from "../src/config.js"
import { makeVoiceSidecars } from "../src/sidecars.js"
import {
  DEFAULT_SUPERVISOR,
  defaultSpawnProcess,
  type SidecarSpec,
  type SidecarStatus,
  type SpawnProcess,
  type SupervisorOptions,
  superviseSidecar,
} from "../src/supervisor.js"
import { buildWav, pcmFromWav } from "../src/wav.js"

const fixtureDir = new URL("./fixtures/", import.meta.url)
const whisperVerbose = readFileSync(new URL("whisper-verbose.json", fixtureDir), "utf8")

type Recorded = { readonly method: string; readonly url: string; readonly body: Buffer }

// A loopback HTTP fake. `route` answers; every request is recorded.
const fakeServer = (route: (req: IncomingMessage, res: ServerResponse, body: Buffer) => void) => {
  const requests: Recorded[] = []
  let server: Server | undefined
  return Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<string>((resolve) => {
          server = createServer((req, res) => {
            const chunks: Buffer[] = []
            req.on("data", (chunk: Buffer) => chunks.push(chunk))
            req.on("end", () => {
              const body = Buffer.concat(chunks)
              requests.push({ method: req.method ?? "", url: req.url ?? "", body })
              route(req, res, body)
            })
          })
          server.listen(0, "127.0.0.1", () => {
            const address = server?.address()
            resolve(typeof address === "object" && address !== null ? `http://127.0.0.1:${address.port}` : "")
          })
        }),
    ).pipe(Effect.map((url) => ({ url, requests }))),
    () =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            if (server === undefined) return resolve()
            server.closeAllConnections()
            server.close(() => resolve())
          }),
      ),
  )
}

const UNREACHABLE = "http://127.0.0.1:1"

const baseConfig = (overrides: Partial<VoiceConfigShape> = {}): VoiceConfigShape => ({
  sttUrl: Option.none(),
  ttsUrl: Option.none(),
  whisperBin: "/nonexistent/whisper-server",
  whisperModel: "/nonexistent/ggml.bin",
  kokoroDir: "/nonexistent/kokoro",
  langDefault: "pt",
  ttsCommand: "/nonexistent/uvicorn",
  ttsCwd: "/nonexistent",
  childEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  ...overrides,
})

const fastSupervisor: Partial<SupervisorOptions> = {
  startupTimeoutMs: 1_000,
  probeTimeoutMs: 300,
  healthIntervalMs: 60_000,
}

const pcm = (length: number): Uint8Array => Uint8Array.from({ length }, (_, index) => index % 251)

const request = (bytes: Uint8Array): TranscribeRequest => ({ pcm16k: bytes })

// A RIFF file with a padding chunk before `data`, like the one macOS `say` writes.
const wavWithPad = (samples: Uint8Array): Uint8Array => {
  const head = buildWav(new Uint8Array(0)).subarray(0, 36)
  const dataHeader = new Uint8Array(8)
  const view = new DataView(dataHeader.buffer)
  view.setUint32(4, samples.length, true)
  dataHeader.set([0x64, 0x61, 0x74, 0x61], 0)
  const padHeader = new Uint8Array(8)
  padHeader.set([0x46, 0x4c, 0x4c, 0x52], 0)
  new DataView(padHeader.buffer).setUint32(4, 4, true)
  const out = new Uint8Array(head.length + padHeader.length + 4 + dataHeader.length + samples.length)
  out.set(head, 0)
  out.set(padHeader, head.length)
  out.set(new Uint8Array(4), head.length + padHeader.length)
  out.set(dataHeader, head.length + padHeader.length + 4)
  out.set(samples, head.length + padHeader.length + 4 + dataHeader.length)
  return out
}

describe("buildWav", () => {
  it("writes a canonical RIFF header, checked field by field", () => {
    const samples = pcm(10)
    const wav = buildWav(samples)
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
    const ascii = (offset: number, length: number) =>
      String.fromCharCode(...wav.subarray(offset, offset + length))

    expect(wav.length).toBe(54)
    expect(ascii(0, 4)).toBe("RIFF")
    expect(view.getUint32(4, true)).toBe(46)
    expect(ascii(8, 4)).toBe("WAVE")
    expect(ascii(12, 4)).toBe("fmt ")
    expect(view.getUint32(16, true)).toBe(16)
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(16_000)
    expect(view.getUint32(28, true)).toBe(32_000)
    expect(view.getUint16(32, true)).toBe(2)
    expect(view.getUint16(34, true)).toBe(16)
    expect(ascii(36, 4)).toBe("data")
    expect(view.getUint32(40, true)).toBe(10)
    expect(wav.subarray(44)).toEqual(samples)
  })

  it("reads the data chunk back past padding chunks", () => {
    const samples = pcm(6)
    expect(pcmFromWav(wavWithPad(samples))).toEqual(samples)
    expect(pcmFromWav(new Uint8Array([1, 2, 3]))).toBeUndefined()
  })
})

describe("VoiceSidecars.transcribe", () => {
  it.live("posts a WAV file part and decodes the verbose_json response", () =>
    Effect.gen(function* () {
      const stt = yield* fakeServer((req, res) => {
        if (req.url === "/health") return res.end('{"status":"ok"}')
        res.setHeader("content-type", "application/json")
        res.end(whisperVerbose)
      })
      const sidecars = makeVoiceSidecars(baseConfig({ sttUrl: Option.some(stt.url) }))
      yield* sidecars.start()
      const samples = pcm(3200)

      const response = yield* sidecars.transcribe(request(samples))

      const post = stt.requests.find((item) => item.url === "/inference")
      expect(post?.method).toBe("POST")
      const body = post?.body ?? Buffer.alloc(0)
      expect(body.includes(Buffer.from(buildWav(samples)))).toBe(true)
      expect(body.includes(Buffer.from("verbose_json"))).toBe(true)
      expect(body.includes(Buffer.from("auto"))).toBe(true)
      expect(response).toEqual({
        text: " Olá, mundo.",
        language: "portuguese",
        languageProbability: 0.98,
        durationMs: 2100,
        segments: [{ text: " Olá, mundo.", start: 0, end: 2.1 }],
      })
    }).pipe(Effect.scoped),
  )

  it.live("fails with a VoiceError when the sidecar does not answer within the timeout", () =>
    Effect.gen(function* () {
      const stt = yield* fakeServer((req, res) => {
        if (req.url === "/health") return res.end('{"status":"ok"}')
        // Never answers /inference: the timeout must end the call.
      })
      const sidecars = makeVoiceSidecars(baseConfig({ sttUrl: Option.some(stt.url) }), {
        sttTimeoutMs: 100,
      })
      yield* sidecars.start()

      const error = yield* Effect.flip(sidecars.transcribe(request(pcm(320))))

      expect(error).toBeInstanceOf(VoiceError)
      expect(error.op).toBe("stt")
      expect(error.reason).toBe("timeout after 100 ms")
    }).pipe(Effect.scoped),
  )

  it.live("refuses an odd-length PCM buffer before calling the sidecar", () =>
    Effect.gen(function* () {
      const stt = yield* fakeServer((_req, res) => res.end('{"status":"ok"}'))
      const sidecars = makeVoiceSidecars(baseConfig({ sttUrl: Option.some(stt.url) }))
      yield* sidecars.start()

      const exit = yield* Effect.exit(sidecars.transcribe(request(pcm(3))))

      expect(Exit.isFailure(exit)).toBe(true)
      expect(stt.requests.some((item) => item.url === "/inference")).toBe(false)
    }).pipe(Effect.scoped),
  )
})

describe("VoiceSidecars.synthesize", () => {
  it.live("consumes the chunked PCM stream of the TTS sidecar", () =>
    Effect.gen(function* () {
      const tts = yield* fakeServer((req, res) => {
        if (req.url === "/health") return res.end('{"ok":true}')
        res.setHeader("content-type", "audio/pcm")
        res.write(Buffer.from("abc"))
        res.write(Buffer.from("def"))
        res.end()
      })
      const sidecars = makeVoiceSidecars(baseConfig({ ttsUrl: Option.some(tts.url) }))
      yield* sidecars.start()

      const chunks = yield* Stream.runCollect(sidecars.synthesize({ text: "teste", language: "pt" }))

      const bytes = Buffer.concat(Array.from(chunks, (chunk) => Buffer.from(chunk)))
      expect(bytes.toString()).toBe("abcdef")
      const post = tts.requests.find((item) => item.url === "/synthesize")
      expect(JSON.parse(post?.body.toString() ?? "{}")).toEqual({ text: "teste", language: "pt" })
    }).pipe(Effect.scoped),
  )

  it.live("falls back to macOS say with the expected arguments when the TTS sidecar is down", () =>
    Effect.gen(function* () {
      const calls: Array<{ command: string; args: ReadonlyArray<string> }> = []
      const speech = pcm(480)
      const spawnSay: SpawnProcess = (command, args) => {
        calls.push({ command, args })
        const out = args[args.indexOf("-o") + 1]
        if (out === undefined) throw new Error("no -o argument")
        writeFileSync(out, wavWithPad(speech))
        const child = new EventEmitter()
        queueMicrotask(() => child.emit("close", 0))
        return child
      }
      const sidecars = makeVoiceSidecars(baseConfig({ ttsUrl: Option.some(UNREACHABLE) }), {
        platform: "darwin",
        spawnProcess: spawnSay,
        supervisor: fastSupervisor,
      })
      yield* sidecars.start()

      const chunks = yield* Stream.runCollect(sidecars.synthesize({ text: "teste", language: "pt" }))

      expect(calls).toHaveLength(1)
      expect(calls[0]?.command).toBe("say")
      const args = calls[0]?.args ?? []
      expect(args.slice(0, 8)).toEqual([
        "-v",
        "Luciana",
        "-r",
        "180",
        "--file-format=WAVE",
        "--data-format=LEI16@24000",
        "-o",
        args[7],
      ])
      expect(args.slice(8)).toEqual(["--", "teste"])
      expect(
        Buffer.concat(Array.from(chunks, (chunk) => Buffer.from(chunk))).equals(Buffer.from(speech)),
      ).toBe(true)
    }).pipe(Effect.scoped),
  )

  it.live("fails with VoiceError op tts outside macOS when the sidecar is down", () =>
    Effect.gen(function* () {
      const sidecars = makeVoiceSidecars(baseConfig({ ttsUrl: Option.some(UNREACHABLE) }), {
        platform: "linux",
        supervisor: fastSupervisor,
      })
      yield* sidecars.start()

      const error = yield* Effect.flip(
        Stream.runCollect(sidecars.synthesize({ text: "teste", language: "pt" })),
      )

      expect(error).toBeInstanceOf(VoiceError)
      expect(error.op).toBe("tts")
    }).pipe(Effect.scoped),
  )
})

describe("VoiceSidecars.start and health", () => {
  it.live("probes the configured server URLs and never spawns", () =>
    Effect.gen(function* () {
      const stt = yield* fakeServer((_req, res) => res.end('{"status":"ok"}'))
      const tts = yield* fakeServer((_req, res) => res.end('{"ok":true}'))
      const spawned: string[] = []
      const sidecars = makeVoiceSidecars(
        baseConfig({ sttUrl: Option.some(stt.url), ttsUrl: Option.some(tts.url) }),
        {
          spawnProcess: (command) => {
            spawned.push(command)
            throw new Error("must not spawn in server mode")
          },
          supervisor: fastSupervisor,
        },
      )

      yield* sidecars.start()

      expect(yield* sidecars.health()).toEqual({ stt: true, tts: true })
      expect(spawned).toEqual([])
    }).pipe(Effect.scoped),
  )

  it.live("reports both sidecars unavailable when their files are missing, without waiting", () =>
    Effect.gen(function* () {
      const sidecars = makeVoiceSidecars(baseConfig(), { supervisor: fastSupervisor })
      const started = Date.now()

      yield* sidecars.start()

      expect(Date.now() - started).toBeLessThan(5_000)
      expect(yield* sidecars.health()).toEqual({ stt: false, tts: false })
    }).pipe(Effect.scoped),
  )

  it.live("rejects a sidecar URL that is not a URL", () =>
    Effect.gen(function* () {
      const sidecars = makeVoiceSidecars(baseConfig({ sttUrl: Option.some("not a url") }), {
        supervisor: fastSupervisor,
      })

      const exit = yield* Effect.exit(sidecars.start())

      expect(Exit.isFailure(exit)).toBe(true)
    }).pipe(Effect.scoped),
  )
})

describe("superviseSidecar", () => {
  // Each life of this child appends a line to the log and exits at once: one line per spawn.
  const crashingSpec = (log: string): SidecarSpec => ({
    name: "stt",
    command: process.execPath,
    args: ["-e", `require("node:fs").appendFileSync(${JSON.stringify(log)}, "x\\n"); process.exit(1)`],
    cwd: tmpdir(),
    env: { PATH: process.env.PATH ?? "" },
    healthUrl: `${UNREACHABLE}/health`,
    requiredFiles: [process.execPath],
  })

  const options: SupervisorOptions = {
    ...DEFAULT_SUPERVISOR,
    healthIntervalMs: 60_000,
    startupTimeoutMs: 10_000,
    probeTimeoutMs: 100,
    restartWindowMs: 300_000,
    maxRestarts: 3,
    backoffMs: 5,
    spawnProcess: defaultSpawnProcess,
  }

  it.live("restarts after each crash and gives up on the fourth", () => {
    const dir = mkdtempSync(join(tmpdir(), "voice-supervisor-"))
    const log = join(dir, "spawns.log")
    return Effect.gen(function* () {
      const statuses: SidecarStatus[] = []
      yield* superviseSidecar(crashingSpec(log), options, (status) =>
        Effect.sync(() => {
          statuses.push(status)
        }),
      )

      const spawns = readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line === "x")
      expect(spawns).toHaveLength(4)
      const last = statuses[statuses.length - 1]
      expect(last?.state).toBe("unavailable")
      expect(last?.reason).toContain("gave up")
      expect(statuses.filter((status) => status.state === "restarting")).toHaveLength(3)
    }).pipe(Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))))
  })

  it.live("never spawns a sidecar whose required file is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "voice-supervisor-"))
    const log = join(dir, "spawns.log")
    const spec: SidecarSpec = { ...crashingSpec(log), requiredFiles: [join(dir, "missing.bin")] }
    return Effect.gen(function* () {
      const statuses: SidecarStatus[] = []
      yield* superviseSidecar(spec, options, (status) =>
        Effect.sync(() => {
          statuses.push(status)
        }),
      )

      expect(statuses).toEqual([{ state: "unavailable", restarts: 0, reason: "required file missing" }])
      expect(() => readFileSync(log, "utf8")).toThrow()
    }).pipe(Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))))
  })
})
