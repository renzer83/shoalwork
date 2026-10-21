import { generateKeyPairSync } from "node:crypto"

// Epoch ms of the fake clock every test starts from.
export const T0 = Date.parse("2026-10-21T12:00:00.000Z")
export const MINUTE = 60_000

// A throwaway RSA key: the App signs its JWT with it, and no request leaves the process.
export const PRIVATE_KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey

export interface Sent {
  readonly method: string
  readonly url: string
  readonly authorization: string | null
  readonly body: unknown
}

export interface Reply {
  readonly status: number
  readonly body: unknown
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

// A GitHub stand-in. Each installation-token request mints "ghs_<n>" valid one hour from the clock; every other
// request is answered by `answer`. Every request is recorded in `sent`.
export const fakeGitHub = (
  clock: { now: number },
  answer: (sent: Sent) => Reply = () => ({ status: 200, body: {} }),
) => {
  const sent: Array<Sent> = []
  let mints = 0
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const text = await request.text()
    const entry: Sent = {
      method: request.method,
      url: request.url,
      authorization: request.headers.get("authorization"),
      body: text === "" ? undefined : JSON.parse(text),
    }
    sent.push(entry)
    if (request.method === "POST" && request.url.endsWith("/access_tokens")) {
      mints += 1
      return json(201, {
        token: `ghs_${mints}`,
        expires_at: new Date(clock.now + 60 * MINUTE).toISOString(),
        permissions: {},
        repository_selection: "all",
      })
    }
    const reply = answer(entry)
    return json(reply.status, reply.body)
  }
  return { fetch: fetchImpl, sent, mints: () => mints }
}
