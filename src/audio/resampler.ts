/**
 * Audio resampling.
 *
 * Default implementation is linear interpolation — fast, dependency-free, and
 * adequate for voice. For higher quality, set a custom `Resampler` impl in the
 * bridge (e.g. a sinc/LPF resampler). Setting the ElevenLabs agent's TTS output
 * format to PCM 16000 Hz avoids resampling entirely on the agent→call path.
 */

export interface Resampler {
  /** Resample `input` (at `inputRate`) to `outputRate`. Mono Float32 in/out. */
  process: (input: Float32Array, inputRate: number, outputRate: number) => Float32Array;
}

/** Linear-interpolation resampler. */
export const linearResampler: Resampler = {
  process(input, inputRate, outputRate) {
    if (inputRate === outputRate) return input.slice();
    if (input.length === 0) return new Float32Array(0);
    if (outputRate === 0) throw new Error("outputRate must be > 0");

    const ratio = outputRate / inputRate;
    const outLength = Math.max(1, Math.round(input.length * ratio));
    const out = new Float32Array(outLength);
    const step = inputRate / outputRate;

    for (let i = 0; i < outLength; i++) {
      const srcPos = i * step;
      const idx = Math.floor(srcPos);
      const frac = srcPos - idx;
      const a = input[idx] ?? 0;
      const b = input[idx + 1] ?? a;
      out[i] = a + (b - a) * frac;
    }
    return out;
  },
};

/**
 * Stateful streaming resampler for chunked audio. Maintains the last sample
 * across calls so consecutive chunks interpolate correctly at the boundary.
 * Use this when feeding audio in small chunks (e.g. ElevenLabs `audio` events)
 * rather than resampling one big buffer at once.
 */
export class StreamingResampler {
  #lastSample = 0;
  #lastPos = 0; // fractional position in input samples carried across chunks
  readonly #resampler: Resampler;

  constructor(resampler: Resampler = linearResampler) {
    this.#resampler = resampler;
  }

  reset = (): void => {
    this.#lastSample = 0;
    this.#lastPos = 0;
  };

  /** Resample a chunk, carrying boundary state. */
  processChunk = (input: Float32Array, inputRate: number, outputRate: number): Float32Array => {
    if (inputRate === outputRate) return input.slice();
    if (input.length === 0) return new Float32Array(0);

    const step = inputRate / outputRate;
    // Prepend the carried last sample so interpolation works at the chunk
    // boundary (the first output sample of this chunk may fall between the
    // previous chunk's last sample and this chunk's first sample).
    const full = new Float32Array(input.length + 1);
    full[0] = this.#lastSample;
    full.set(input, 1);

    const out: number[] = [];
    // pos is relative to `full`. Start at 1 + carried position (skip the
    // virtual prepended sample on the first chunk when lastPos is 0).
    let pos = 1 + this.#lastPos;
    while (pos < full.length - 1) {
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const a = full[idx];
      const b = full[idx + 1] ?? a;
      out.push(a + (b - a) * frac);
      pos += step;
    }
    // Carry the last input sample and the overflow position (relative to next chunk's offset 1).
    this.#lastSample = input[input.length - 1] ?? this.#lastSample;
    this.#lastPos = pos - full.length;
    return new Float32Array(out);
  };
}
