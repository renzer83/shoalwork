import type { ExecutorEvent, ExecutorId } from "@shoalwork/contracts"
import { Effect } from "effect"
import type { ExhaustedSource, QuotaStoreShape } from "./store.js"

// A bare 429 as a status code: not a stack-trace position (`x.js:429:12`), not part of a longer number (`14290`).
const HTTP_429 = /(?<![:\w.])429(?![\d:])/
// Starting point until real limit texts are captured (UNVERIFIED per CLI, see 06-research/claude-code.md). The same
// pattern serves every executor; a per-executor pattern is added here once a real fixture exists.
export const LIMIT_TEXT =
  /(?<![:\w.])429(?![\d:])|too many requests|rate[ -]limit|usage limit|limit reached|quota (exceeded|exhausted)/i

// Classifies an error text as a limit signal. Undefined when the text names no limit. Only error messages are
// classified: callers never pass the result text of a successful run.
export const limitSignalOf = (text: string): ExhaustedSource | undefined => {
  if (!LIMIT_TEXT.test(text)) return undefined
  return HTTP_429.test(text) ? "429" : "limit_text"
}

// Attaches to an adapter's event stream: usage is recorded, and an error that names a limit marks the executor as
// exhausted. Store failures are logged, not raised: the run goes on and the CLI reports the limit itself.
export const observeQuota =
  (store: QuotaStoreShape | undefined, executor: ExecutorId) =>
  (event: ExecutorEvent): Effect.Effect<void> => {
    if (store === undefined) return Effect.void
    if (event.kind === "usage") {
      return store
        .record(executor, event.usage)
        .pipe(Effect.catch((error) => Effect.logError("quota usage not recorded", error)))
    }
    if (event.kind === "error" && (event.code === "auth" || event.code === "unknown")) {
      const source = limitSignalOf(event.message)
      if (source !== undefined) {
        return store
          .markExhausted(executor, source)
          .pipe(Effect.catch((error) => Effect.logError("quota exhaustion not recorded", error)))
      }
    }
    return Effect.void
  }
