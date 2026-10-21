import { describe, expect, it } from "vitest"
import { decrypt, encrypt } from "../src/crypto.js"

describe("vault crypto (AES-256-GCM)", () => {
  it("encrypt then decrypt round-trips the plaintext", () => {
    const value = "sk-fixture-secret-value-1234567890"
    const key = "fixture-vault-key"
    expect(decrypt(encrypt(value, key), key)).toBe(value)
  })

  it("produces a ciphertext that does not contain the plaintext", () => {
    const value = "sk-fixture-secret-value-1234567890"
    const ciphertext = encrypt(value, "fixture-vault-key")
    expect(ciphertext).not.toContain(value)
  })

  it("rejects a payload decrypted with the wrong key", () => {
    const ciphertext = encrypt("secret-value", "correct-key")
    expect(() => decrypt(ciphertext, "wrong-key")).toThrow()
  })

  it("rejects a tampered payload", () => {
    const ciphertext = encrypt("secret-value", "correct-key")
    const buf = Buffer.from(ciphertext, "base64")
    buf[0] = buf[0] === 0 ? 1 : 0
    expect(() => decrypt(buf.toString("base64"), "correct-key")).toThrow()
  })
})
