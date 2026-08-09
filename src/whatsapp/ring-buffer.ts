/**
 * Sample-level ring buffer for streaming PCM audio.
 *
 * Producers push Float32Array sample frames; consumers pull fixed-size chunks.
 * On overflow the oldest samples are dropped (prioritize low latency / fresh
 * audio over completeness — important for real-time TTS where stale audio is
 * worse than a brief dropout). On underflow the consumer gets fewer samples
 * than requested (the caller decides whether to pad with silence).
 */
export class RingBuffer {
  readonly #capacity: number;
  #buf: Float32Array;
  #head = 0; // next read position
  #tail = 0; // next write position
  #full = false;

  droppedSamples = 0;
  underflowSamples = 0;

  constructor(capacitySamples: number) {
    if (capacitySamples <= 0) throw new Error("capacity must be > 0");
    this.#capacity = capacitySamples;
    this.#buf = new Float32Array(capacitySamples);
  }

  get capacity(): number { return this.#capacity; }
  get length(): number {
    if (this.#full) return this.#capacity;
    if (this.#tail >= this.#head) return this.#tail - this.#head;
    return this.#capacity - this.#head + this.#tail;
  }

  clear = (): void => {
    this.#head = 0;
    this.#tail = 0;
    this.#full = false;
    this.droppedSamples = 0;
    this.underflowSamples = 0;
  };

  /**
   * Append samples. If the buffer is full, the oldest samples are overwritten
   * (dropped) to make room for the newer ones.
   */
  push = (samples: Float32Array): void => {
    if (samples.length === 0) return;
    if (samples.length >= this.#capacity) {
      // Replace entire buffer with the tail of the input.
      const start = samples.length - this.#capacity;
      this.#buf.set(samples.subarray(start));
      this.#head = 0;
      this.#tail = 0;
      this.#full = true;
      this.droppedSamples += start;
      return;
    }

    let remaining = samples.length;
    let srcOff = 0;
    while (remaining > 0) {
      if (this.#full) {
        // Drop oldest to make room — advance head by the amount we need.
        const drop = Math.min(remaining, this.#capacity);
        this.#head = (this.#head + drop) % this.#capacity;
        this.#full = false;
        this.droppedSamples += drop;
      }
      // First contiguous write region: tail -> min(head if tail<head, else capacity).
      const writeEnd = this.#tail < this.#head ? this.#head : this.#capacity;
      const space = writeEnd - this.#tail;
      if (space <= 0) {
        // tail == capacity and head == 0 — wrap; next iteration tail < head.
        this.#tail = 0;
        continue;
      }
      const n = Math.min(space, remaining);
      this.#buf.set(samples.subarray(srcOff, srcOff + n), this.#tail);
      this.#tail = (this.#tail + n) % this.#capacity;
      srcOff += n;
      remaining -= n;
      if (this.#head === this.#tail) this.#full = true;
    }
  };

  /**
   * Pull up to `count` samples into `out` (or a new array if omitted).
   * Returns the number of samples actually read (may be < count on underflow).
   * Tracks underflow in `underflowSamples`.
   */
  pull = (count: number, out?: Float32Array): Float32Array => {
    const available = this.length;
    const toRead = Math.min(count, available);
    const target = out && out.length >= count ? out : new Float32Array(count);
    if (toRead === 0) {
      this.underflowSamples += count;
      return target;
    }
    if (count > toRead) this.underflowSamples += count - toRead;

    const firstChunk = Math.min(toRead, this.#capacity - this.#head);
    target.set(this.#buf.subarray(this.#head, this.#head + firstChunk), 0);
    if (toRead > firstChunk) {
      target.set(this.#buf.subarray(0, toRead - firstChunk), firstChunk);
    }
    this.#head = (this.#head + toRead) % this.#capacity;
    this.#full = false;
    return target;
  };
}
