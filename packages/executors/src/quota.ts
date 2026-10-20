import type { ExecutorId, QuotaStatus, Usage } from "@shoalwork/contracts"
import { DateTime } from "effect"

export type QuotaCounter = {
  readonly record: (usage: Usage) => void
  readonly status: () => QuotaStatus
}

// Fixed window: it opens on the first record after the previous window expired.
// Tokens are tokensIn + tokensOut. `now` (epoch ms) is injected so tests need no real sleep.
export const makeQuotaCounter = (
  executor: ExecutorId,
  windowSeconds: number,
  softLimitTokens: number,
  now: () => number = Date.now,
): QuotaCounter => {
  const windowMs = windowSeconds * 1000
  let windowStart: number | undefined
  let used = 0

  const roll = (at: number): void => {
    if (windowStart !== undefined && at < windowStart + windowMs) return
    windowStart = undefined
    used = 0
  }

  return {
    record: (usage) => {
      const at = now()
      roll(at)
      if (windowStart === undefined) windowStart = at
      used += usage.tokensIn + usage.tokensOut
    },
    status: () => {
      roll(now())
      const usedRatio = softLimitTokens > 0 ? Math.min(1, used / softLimitTokens) : 1
      return {
        executor,
        usedRatio,
        available: used < softLimitTokens,
        ...(windowStart === undefined ? {} : { windowEndsAt: DateTime.makeUnsafe(windowStart + windowMs) }),
      }
    },
  }
}
