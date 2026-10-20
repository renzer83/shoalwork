import { MAX_ATTEMPTS } from "./retry.js"
import { clip } from "./verdict.js"

// Pure phrases for Renan (pt-BR). Sending them to Telegram is the connector's job (T-024).
const DIAGNOSIS_MAX = 200

// `attempt` is the number of the new run: the retry after the first failure is "2/2".
export const retryingPhrase = (attempt: number): string => `Tentando de novo (${attempt}/${MAX_ATTEMPTS})…`

// Escalation after the last attempt failed: the short diagnosis, never the raw executor output.
export const needsYouPhrase = (diagnosis: string): string =>
  `Precisa de você: ${clip(diagnosis.replace(/\s+/g, " ").trim(), DIAGNOSIS_MAX)}`
