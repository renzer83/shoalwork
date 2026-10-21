type ResponseHeaders = Record<string, string | Array<string>>

const ALLOWED_HEADERS = "authorization, content-type, accept, last-event-id"
const ALLOWED_METHODS = "GET, POST, PATCH, DELETE, OPTIONS"

// The app is served from its own origin, the core from http: the browser engine treats every call as cross-origin,
// and the core sends no CORS headers. The desktop shell adds them to answers from the configured core only.
export const withCors = (headers: ResponseHeaders | undefined, origin: string): ResponseHeaders => {
  const kept: ResponseHeaders = {}
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (!name.toLowerCase().startsWith("access-control-")) {
      kept[name] = value
    }
  }
  return {
    ...kept,
    "access-control-allow-origin": origin,
    "access-control-allow-headers": ALLOWED_HEADERS,
    "access-control-allow-methods": ALLOWED_METHODS,
    vary: "Origin",
  }
}

// A preflight reaches the core as OPTIONS and gets 401 or 404; the browser needs a 2xx.
export const preflightStatusLine = (method: string): string | undefined =>
  method.toUpperCase() === "OPTIONS" ? "HTTP/1.1 204 No Content" : undefined
