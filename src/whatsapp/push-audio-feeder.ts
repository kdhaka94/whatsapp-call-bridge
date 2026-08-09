/**
 * PushAudioFeeder — a streaming replacement for baileys-caller's file-based
 * AudioFeeder. Instead of spawning ffmpeg to decode a file, it reads from an
 * internal ring buffer that producers push Float32Array sample frames into.
 *
 * Maintains the same cadence contract: emits `Float32Array` chunks of
 * `framesPerChunk * channels` samples at `(framesPerChunk / sampleRate) * 1000`
 * ms intervals via `onChunk`. On underflow emits a zero-filled (silence) chunk
 * so the WhatsApp uplink never stalls.
 *
 * Used to feed ElevenLabs agent TTS audio into a live WhatsApp call in real time.
 */
import { RingBuffer } from "./ring-buffer.js";

export interface AudioFeederLike {
  start: () => void;
  stop: () => void;
}

export type PushAudioFeederOptions = {
  /** Buffer depth in seconds of audio. Default 2s. Larger = more jitter tolerance, more latency. */
  bufferSeconds?: number;
  /** Enable debug logging of feeder stats. Default false. */
  debug?: boolean;
};

const MAX_QUEUE_SECONDS = 30; // hard cap to bound memory

export class PushAudioFeeder implements AudioFeederLike {
  #ring: RingBuffer;
  #emitTimer: NodeJS.Timeout | null = null;
  #nextEmitAtMs = 0;
  #running = false;

  readonly #sampleRate: number;
  readonly #channels: number;
  readonly #framesPerChunk: number;
  readonly #chunkSamples: number;
  readonly #chunkIntervalMs: number;
  readonly #onChunk: (chunk: Float32Array) => void;
  readonly #debug: boolean;

  // stats
  chunksEmitted = 0;
  silenceChunks = 0;

  constructor(
    sampleRate: number,
    channels: number,
    framesPerChunk: number,
    onChunk: (chunk: Float32Array) => void,
    options: PushAudioFeederOptions = {},
  ) {
    this.#sampleRate = sampleRate;
    this.#channels = channels;
    this.#framesPerChunk = framesPerChunk;
    this.#chunkSamples = framesPerChunk * channels;
    this.#chunkIntervalMs = (framesPerChunk / sampleRate) * 1000;
    this.#onChunk = onChunk;
    this.#debug = options.debug ?? false;

    const bufSeconds = Math.min(options.bufferSeconds ?? 2, MAX_QUEUE_SECONDS);
    const capacity = Math.ceil(sampleRate * channels * bufSeconds);
    this.#ring = new RingBuffer(capacity);
  }

  get droppedSamples(): number { return this.#ring.droppedSamples; }
  get underflowSamples(): number { return this.#ring.underflowSamples; }
  get bufferedSamples(): number { return this.#ring.length; }
  get bufferedMs(): number {
    return this.#channels > 0 ? (this.#ring.length / this.#channels / this.#sampleRate) * 1000 : 0;
  }

  /** Append audio samples to the feeder's internal buffer. */
  push = (samples: Float32Array): void => {
    this.#ring.push(samples);
  };

  /** Remove all buffered audio (e.g. on interruption). */
  flush = (): void => {
    this.#ring.clear();
  };

  start = (): void => {
    if (this.#running) return;
    this.#running = true;
    this.#nextEmitAtMs = 0;
    this.#scheduleNext();
  };

  stop = (): void => {
    this.#running = false;
    if (this.#emitTimer) {
      clearTimeout(this.#emitTimer);
      this.#emitTimer = null;
    }
    this.#ring.clear();
  };

  #scheduleNext = (): void => {
    if (!this.#running) return;
    const now = Date.now();
    if (this.#nextEmitAtMs === 0) this.#nextEmitAtMs = now;
    const delayMs = Math.max(0, this.#nextEmitAtMs - now);

    this.#emitTimer = setTimeout(() => {
      this.#emitTimer = null;
      this.#flushOne();
      this.#nextEmitAtMs += this.#chunkIntervalMs;
      this.#scheduleNext();
    }, delayMs);
  };

  #flushOne = (): void => {
    const chunk = this.#ring.pull(this.#chunkSamples);
    const isSilence = this.#ring.underflowSamples > 0 && this.#isZero(chunk);
    if (isSilence) this.silenceChunks += 1;
    this.chunksEmitted += 1;
    this.#onChunk(chunk);
    if (this.#debug && this.chunksEmitted % 250 === 0) {
      console.log(
        `[PushAudioFeeder] emitted=${this.chunksEmitted} silence=${this.silenceChunks} ` +
        `buffered=${this.bufferedMs.toFixed(0)}ms dropped=${this.droppedSamples} underflow=${this.underflowSamples}`,
      );
    }
  };

  #isZero = (arr: Float32Array): boolean => {
    for (let i = 0; i < arr.length; i++) if (arr[i] !== 0) return false;
    return true;
  };
}
