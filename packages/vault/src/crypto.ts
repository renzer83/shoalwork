import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"

// AES-256-GCM envelope for the Vault file backend (T-064). The key material is derived from VAULT_KEY with
// SHA-256 (a passphrase), and the stored payload is base64(iv || authTag || ciphertext).
const ALGORITHM = "aes-256-gcm"
const IV_BYTES = 12
const TAG_BYTES = 16

const deriveKey = (secret: string): Buffer => createHash("sha256").update(secret).digest()

// Glue over node:crypto: throws on a bad key or a tampered payload (the caller maps that to a typed error).
export const encrypt = (plain: string, key: string): string => {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, deriveKey(key), iv)
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, encrypted]).toString("base64")
}

export const decrypt = (payload: string, key: string): string => {
  const buf = Buffer.from(payload, "base64")
  const iv = buf.subarray(0, IV_BYTES)
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const encrypted = buf.subarray(IV_BYTES + TAG_BYTES)
  const decipher = createDecipheriv(ALGORITHM, deriveKey(key), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8")
}
