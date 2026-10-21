// The Silero chunk: 512 samples of 16 kHz mono s16le, i.e. 32 ms and 1024 bytes.
export const SAMPLE_RATE = 16_000
export const FRAME_SAMPLES = 512
export const FRAME_BYTES = FRAME_SAMPLES * 2
export const FRAME_MS = (FRAME_SAMPLES / SAMPLE_RATE) * 1000

export type Frame = {
  readonly pcm: Int16Array
  // Milliseconds since the start of the capture, at the first sample of the frame.
  readonly t: number
}

export type Utterance = {
  // Whole utterance, pad included, as 16 kHz mono PCM: ready for the STT sidecar.
  readonly pcm: Int16Array
  readonly startMs: number
  readonly endMs: number
  readonly maxProb: number
}

// Explicit little-endian read, so the result does not depend on the host byte order.
export const frameFromBytes = (bytes: Uint8Array, offset: number): Int16Array => {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, FRAME_BYTES)
  const pcm = new Int16Array(FRAME_SAMPLES)
  for (let i = 0; i < FRAME_SAMPLES; i++) pcm[i] = view.getInt16(i * 2, true)
  return pcm
}

// Little-endian bytes of PCM, the inverse of `frameFromBytes` (what the STT sidecar and `play` take).
export const bytesFromPcm = (pcm: Int16Array): Uint8Array => {
  const bytes = new Uint8Array(pcm.length * 2)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < pcm.length; i++) view.setInt16(i * 2, pcm[i] ?? 0, true)
  return bytes
}
