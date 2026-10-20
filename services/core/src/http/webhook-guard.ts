// Guards in front of an inbound webhook, before anything is authenticated or parsed.

// A body larger than this is refused with 413; the rest of it is never read (T-045 FIX_1).
export const GITHUB_BODY_LIMIT_BYTES = 5 * 1024 * 1024
export const ERROR_WINDOW_MS = 60_000

export interface ErrorAdmission {
  // true: record one error.raised for this tag now. false: this tag was recorded inside the window, log only.
  readonly record: boolean
  // Refusals of this tag that were not recorded in the previous window.
  readonly suppressed: number
}

export interface ErrorLimiter {
  readonly admit: (tag: string, nowMs: number) => ErrorAdmission
}

// In memory and per route: at most one error.raised per tag per window, so a flood of bad requests writes one event.
export const makeErrorLimiter = (windowMs: number = ERROR_WINDOW_MS): ErrorLimiter => {
  const windows = new Map<string, { start: number; suppressed: number }>()
  return {
    admit: (tag, nowMs) => {
      const window = windows.get(tag)
      if (window === undefined || nowMs - window.start >= windowMs) {
        const suppressed = window?.suppressed ?? 0
        windows.set(tag, { start: nowMs, suppressed: 0 })
        return { record: true, suppressed }
      }
      window.suppressed += 1
      return { record: false, suppressed: window.suppressed }
    },
  }
}

export type DeclaredLength = "absent" | "invalid" | number

// Content-Length as declared: digits only, anything else is invalid (a 400 before any read).
export const declaredLength = (header: string | undefined): DeclaredLength => {
  if (header === undefined) return "absent"
  return /^\d{1,15}$/.test(header) ? Number(header) : "invalid"
}

// Streams the body and stops at the limit, for declared and chunked bodies alike. Undefined when it is over the limit:
// the reader is cancelled and nothing more is pulled.
export const readBounded = async (
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array | undefined> => {
  if (body === null) return new Uint8Array(0)
  const reader = body.getReader()
  const chunks: Array<Uint8Array> = []
  let total = 0
  let next = await reader.read()
  while (!next.done) {
    total += next.value.byteLength
    if (total > limit) {
      await reader.cancel()
      return undefined
    }
    chunks.push(next.value)
    next = await reader.read()
  }
  return Buffer.concat(chunks)
}
