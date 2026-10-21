// WAV helpers for the STT input (RIFF, PCM 16 kHz mono s16le) and the `say` fallback output.

export const WAV_SAMPLE_RATE = 16_000
const HEADER_BYTES = 44

const writeAscii = (bytes: Uint8Array, offset: number, text: string): void => {
  for (let i = 0; i < text.length; i += 1) bytes[offset + i] = text.charCodeAt(i)
}

// Canonical 44-byte header, little endian. Checked byte by byte in test/sidecars.test.ts.
export const buildWav = (pcm: Uint8Array): Uint8Array<ArrayBuffer> => {
  const out: Uint8Array<ArrayBuffer> = new Uint8Array(HEADER_BYTES + pcm.length)
  const view = new DataView(out.buffer)
  writeAscii(out, 0, "RIFF")
  view.setUint32(4, 36 + pcm.length, true)
  writeAscii(out, 8, "WAVE")
  writeAscii(out, 12, "fmt ")
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, WAV_SAMPLE_RATE, true)
  view.setUint32(28, WAV_SAMPLE_RATE * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeAscii(out, 36, "data")
  view.setUint32(40, pcm.length, true)
  out.set(pcm, HEADER_BYTES)
  return out
}

const readAscii = (bytes: Uint8Array, offset: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(offset, offset + length))

// The samples of the `data` chunk. Chunks before it (macOS writes a FLLR pad) are skipped.
// Undefined when the bytes are not a RIFF/WAVE file with a data chunk.
export const pcmFromWav = (wav: Uint8Array): Uint8Array | undefined => {
  if (wav.length < 12 || readAscii(wav, 0, 4) !== "RIFF" || readAscii(wav, 8, 4) !== "WAVE") return undefined
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  let offset = 12
  while (offset + 8 <= wav.length) {
    const id = readAscii(wav, offset, 4)
    const size = view.getUint32(offset + 4, true)
    const start = offset + 8
    if (id === "data") return wav.subarray(start, Math.min(start + size, wav.length))
    offset = start + size + (size % 2)
  }
  return undefined
}
