/**
 * PCM audio conversion utilities.
 *
 * Bridges between the three audio representations used in this library:
 * - `Float32Array`  — WhatsApp Web WASM's native format (mono, [-1, 1], 16 kHz)
 * - `Int16` LE PCM   — ElevenLabs Conversational AI's `pcm_16000` wire format
 * - base64 string    — ElevenLabs WebSocket message encoding
 *
 * All conversions are pure (no allocations beyond the output buffer) and have
 * no dependencies, so they're fast and testable.
 */

/** Clamp a float sample to [-1, 1]. */
export const clamp = (s: number): number => (s > 1 ? 1 : s < -1 ? -1 : s);

/**
 * Convert Float32 samples (-1..1) to Int16 LE PCM bytes (little-endian).
 * Values outside [-1, 1] are clipped.
 */
export const float32ToInt16 = (input: Float32Array): Buffer => {
  const out = Buffer.allocUnsafe(input.length * 2);
  for (let i = 0; i < input.length; i++) {
    const s = clamp(input[i]);
    // Map -1.0 to -32768 (min int16); everything else to round(s * 32767).
    out.writeInt16LE(s <= -1 ? -32768 : Math.round(s * 32767), i * 2);
  }
  return out;
};

/**
 * Convert Int16 LE PCM bytes to Float32 samples (-1..1).
 * Non-Int16 bytes are ignored (only full samples read).
 */
export const int16ToFloat32 = (input: Buffer): Float32Array => {
  const sampleCount = Math.floor(input.length / 2);
  const out = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    out[i] = input.readInt16LE(i * 2) / 32768;
  }
  return out;
};

/** Encode a Buffer to a base64 string (for ElevenLabs `user_audio_chunk`). */
export const bufferToBase64 = (buf: Buffer): string => buf.toString("base64");

/** Decode a base64 string to a Buffer (for ElevenLabs `audio` events). */
export const base64ToBuffer = (b64: string): Buffer => Buffer.from(b64, "base64");

/** Convenience: Float32 -> Int16 -> base64 (user audio for ElevenLabs). */
export const float32ToBase64 = (input: Float32Array): string =>
  bufferToBase64(float32ToInt16(input));

/** Convenience: base64 -> Int16 Buffer -> Float32 (agent audio from ElevenLabs). */
export const base64ToFloat32 = (b64: string): Float32Array =>
  int16ToFloat32(base64ToBuffer(b64));

/**
 * Downmix multi-channel Float32 (interleaved) to mono Float32 by averaging
 * channels. If already mono, returns a copy. If `channels` is 1, samples are
 * passed through.
 */
export const downmixToMono = (input: Float32Array, channels: number): Float32Array => {
  if (channels <= 1) return input.slice();
  const frameCount = Math.floor(input.length / channels);
  const out = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    let sum = 0;
    const base = i * channels;
    for (let c = 0; c < channels; c++) sum += input[base + c];
    out[i] = sum / channels;
  }
  return out;
};
