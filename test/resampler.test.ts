import { describe, it, expect } from "vitest";
import { linearResampler, StreamingResampler } from "../src/audio/resampler.js";

describe("linearResampler", () => {
  it("returns a copy when rates are equal", () => {
    const input = Float32Array.from([1, 2, 3, 4]);
    const out = linearResampler.process(input, 16000, 16000);
    expect(Array.from(out)).toEqual([1, 2, 3, 4]);
    expect(out).not.toBe(input);
  });

  it("handles empty input", () => {
    expect(linearResampler.process(new Float32Array(0), 16000, 48000).length).toBe(0);
  });

  it("throws on zero output rate", () => {
    expect(() => linearResampler.process(Float32Array.from([1]), 16000, 0)).toThrow();
  });

  it("upsamples 16k -> 48k (3x) with linear interpolation", () => {
    // Two input samples: 0.0 and 1.0 at 16k. Upsample to 48k → 6 samples.
    const input = Float32Array.from([0, 1]);
    const out = linearResampler.process(input, 16000, 48000);
    expect(out.length).toBe(6);
    // step = 16000/48000 = 1/3
    // positions: 0, 1/3, 2/3, 1, 4/3, 5/3
    // values: 0, 1/3, 2/3, 1, 1, 1 (idx clamps at last)
    expect(out[0]).toBeCloseTo(0, 5);
    expect(out[1]).toBeCloseTo(1 / 3, 5);
    expect(out[2]).toBeCloseTo(2 / 3, 5);
    expect(out[3]).toBeCloseTo(1, 5);
    // Beyond the second sample, interpolation holds the last value.
    expect(out[4]).toBeCloseTo(1, 5);
    expect(out[5]).toBeCloseTo(1, 5);
  });

  it("downsamples 48k -> 16k (1/3x) picking every 3rd sample", () => {
    // 6 input samples at 48k: 0, 1, 2, 3, 4, 5 → 2 output at 16k
    const input = Float32Array.from([0, 1, 2, 3, 4, 5]);
    const out = linearResampler.process(input, 48000, 16000);
    expect(out.length).toBe(2);
    // step = 48000/16000 = 3 → positions 0, 3 → values input[0]=0, input[3]=3
    expect(out[0]).toBeCloseTo(0, 5);
    expect(out[1]).toBeCloseTo(3, 5);
  });

  it("preserves a sine wave approximately when downsampling within reason", () => {
    // 44100 -> 16000 on a 440 Hz sine, check it's still bounded and non-trivial.
    const inRate = 44100;
    const outRate = 16000;
    const duration = 0.05; // 50ms
    const inLen = Math.floor(inRate * duration);
    const input = new Float32Array(inLen);
    for (let i = 0; i < inLen; i++) input[i] = Math.sin((2 * Math.PI * 440 * i) / inRate);
    const out = linearResampler.process(input, inRate, outRate);
    expect(out.length).toBeGreaterThan(0);
    const maxAbs = Math.max(...Array.from(out).map(Math.abs));
    expect(maxAbs).toBeGreaterThan(0.5); // sine peaks ~1
    expect(maxAbs).toBeLessThanOrEqual(1);
  });
});

describe("StreamingResampler", () => {
  it("produces same result as one-shot for a single chunk", () => {
    const input = Float32Array.from([0, 1, 2, 3, 4, 5]);
    const oneShot = linearResampler.process(input, 48000, 16000);
    const sr = new StreamingResampler();
    const streamed = sr.processChunk(input, 48000, 16000);
    expect(streamed.length).toBe(oneShot.length);
    for (let i = 0; i < streamed.length; i++) {
      expect(streamed[i]).toBeCloseTo(oneShot[i], 5);
    }
  });

  it("matches one-shot when input is split across chunks", () => {
    const input = Float32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const oneShot = linearResampler.process(input, 48000, 16000);

    const sr = new StreamingResampler();
    const a = sr.processChunk(input.subarray(0, 4), 48000, 16000);
    const b = sr.processChunk(input.subarray(4), 48000, 16000);
    const streamed = new Float32Array(a.length + b.length);
    streamed.set(a, 0);
    streamed.set(b, a.length);

    // Counts should match (boundary may differ by ±1 due to rounding).
    expect(Math.abs(streamed.length - oneShot.length)).toBeLessThanOrEqual(1);
    const minLen = Math.min(streamed.length, oneShot.length);
    for (let i = 0; i < minLen; i++) {
      expect(streamed[i]).toBeCloseTo(oneShot[i], 4);
    }
  });

  it("reset() clears state", () => {
    const sr = new StreamingResampler();
    sr.processChunk(Float32Array.from([1, 2, 3]), 48000, 16000);
    sr.reset();
    // After reset, processing the same input should give the same as fresh.
    const out = sr.processChunk(Float32Array.from([1, 2, 3]), 48000, 16000);
    const fresh = new StreamingResampler().processChunk(Float32Array.from([1, 2, 3]), 48000, 16000);
    expect(out.length).toBe(fresh.length);
  });

  it("passes through when rates match", () => {
    const sr = new StreamingResampler();
    const out = sr.processChunk(Float32Array.from([1, 2, 3]), 16000, 16000);
    expect(Array.from(out)).toEqual([1, 2, 3]);
  });
});
