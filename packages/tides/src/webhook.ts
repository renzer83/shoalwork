import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

// 256 random bits, shown once to the operator. Only its SHA-256 is stored (tides.secret).
export const generateWebhookSecret = (): string => randomBytes(32).toString("base64url")

const digest = (text: string): Buffer => createHash("sha256").update(text, "utf8").digest()

export const hashWebhookSecret = (secret: string): string => digest(secret).toString("hex")

// Used when the tide has no secret (or does not exist): the comparison still runs, so the answer takes the same time.
const NO_SECRET_DIGEST = digest("")

// Compares digests in constant time. A null stored value (no secret, or an unknown tide) never matches.
export const secretMatches = (stored: string | null, presented: string): boolean => {
  const given = digest(presented)
  const expected = stored === null ? NO_SECRET_DIGEST : Buffer.from(stored, "hex")
  return stored !== null && expected.length === given.length && timingSafeEqual(expected, given)
}
