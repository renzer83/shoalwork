import { readFileSync } from "node:fs"

// Fixtures are read from test/fixtures (no network). Shapes follow the documented Stripe answers, or the stand-in
// contracts of the billing-gateway and the control-panel (ADR-022: no contract received yet).
export const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"))

// A JSON answer with the given status.
export const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

export interface RecordedCall {
  readonly url: URL
  readonly init: RequestInit
}

// A fetch that answers with `reply` and records every call. No network.
export const recordingFetch = (reply: (url: URL) => Response) => {
  const calls: Array<RecordedCall> = []
  const doFetch = async (url: URL, init: RequestInit): Promise<Response> => {
    calls.push({ url, init })
    return reply(url)
  }
  return { doFetch, calls }
}

// The Authorization header of a recorded call, read the way fetch receives it.
export const authorizationOf = (call: RecordedCall): string | undefined => {
  const headers = call.init.headers
  if (headers === undefined || Array.isArray(headers) || headers instanceof Headers) return undefined
  return (headers as Record<string, string>).Authorization
}
