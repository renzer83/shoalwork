// A value runs to the next quote, whitespace, backslash or separator, so it also ends inside a JSON string.
const VALUE = String.raw`[^\s"'\\,;}]+`

const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Authorization / proxy-authorization headers, with or without a scheme (also as `-H "Authorization: …"`).
  [
    new RegExp(String.raw`((?:proxy-)?authorization\s*[:=]\s*)(?:(?:bearer|basic|token)\s+)?${VALUE}`, "gi"),
    "$1[redacted]",
  ],
  // Other credential headers.
  [
    /((?:x-api-key|api-key|x-auth-token|x-access-token|cookie|set-cookie)\s*:\s*)[^\n"'\\]+/gi,
    "$1[redacted]",
  ],
  // Bare bearer tokens.
  [/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]"],
  // --password=x, --token x, --api-key=x and the like.
  [
    new RegExp(
      String.raw`(--(?:password|passwd|pass|token|secret|api-?key|access-?key|auth)(?:=|\s+))${VALUE}`,
      "gi",
    ),
    "$1[redacted]",
  ],
  // password=x, token: x, API_KEY=x inline.
  [
    new RegExp(
      String.raw`\b((?:[a-z0-9_.-]*)(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\s*[=:]\s*)${VALUE}`,
      "gi",
    ),
    "$1[redacted]",
  ],
  // user:password@host in URLs.
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@"']+:)[^\s/@"']+@/gi, "$1[redacted]@"],
  // Well-known token shapes (provider prefixes, JWTs) wherever they appear.
  [
    /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{12,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
    "[redacted]",
  ],
]

// Text the model produced that is stored, sent and shown (an approval's input): credentials are masked in place and
// the rest of the text is kept (unlike redactResource, which cuts a path at its query string).
export const redactText = (text: string): string =>
  PATTERNS.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text)
