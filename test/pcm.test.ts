import { describe, it, expect } from "vitest";
import {
  clamp,
  float32ToInt16,
  int16ToFloat32,
  bufferToBase64,
  base64ToBuffer,
  float32ToBase64,
  base64ToFloat32,
  downmixToMono,
} from "../src/audio/pcm.js";

describe("clamp", () => {
  it("clamps values outside [-1, 1]", () => {
    expect(clamp(2)).toBe(1);
    expect(clamp(-2)).toBe(-1);
    expect(clamp(0.5)).toBe(0.5);
    expect(clamp(0)).toBe(0);
  });
});

describe("float32 <-> int16", () => {
  it("round-trips within quantization tolerance", () => {
    const input = Float32Array.from([0, 0.5, -0.5, 1, -1, 0.25, -0.75]);
    const int16 = float32ToInt16(input);
    const back = int16ToFloat32(int16);
    expect(back.length).toBe(input.length);
    for (let i = 0; i < input.length; i++) {
      expect(Math.abs(back[i] - input[i])).toBeLessThan(1 / 32767);
    }
  });

  it("clips out-of-range floats", () => {
    const input = Float32Array.from([2, -2, 1.5]);
    const int16 = float32ToInt16(input);
    expect(int16.readInt16LE(0)).toBe(32767); // +2 -> max
    expect(int16.readInt16LE(2)).toBe(-32768); // -2 -> min
    expect(int16.readInt16LE(4)).toBe(32767); // +1.5 -> max
  });

  it("maps 1.0 to max int16 and -1.0 to min int16", () => {
    const int16 = float32ToInt16(Float32Array.from([1, -1]));
    expect(int16.readInt16LE(0)).toBe(32767);
    expect(int16.readInt16LE(2)).toBe(-32768);
  });

  it("handles empty input", () => {
    expect(float32ToInt16(new Float32Array(0)).length).toBe(0);
    expect(int16ToFloat32(Buffer.alloc(0)).length).toBe(0);
  });

  it("ignores trailing odd byte in int16 input", () => {
    const buf = Buffer.alloc(3);
    buf.writeInt16LE(16384, 0); // 0.5
    buf[2] = 0xff; // trailing byte ignored
    const out = int16ToFloat32(buf);
    expect(out.length).toBe(1);
    expect(out[0]).toBeCloseTo(0.5, 4);
  });
});

describe("base64", () => {
  it("round-trips buffers", () => {
    const buf = Buffer.from([1, 2, 3, 255, 0, 128]);
    const b64 = bufferToBase64(buf);
    expect(base64ToBuffer(b64)).toEqual(buf);
  });

  it("float32ToBase64 / base64ToFloat32 round-trip", () => {
    const input = Float32Array.from([0, 0.5, -0.5, 1, -1]);
    const b64 = float32ToBase64(input);
    const back = base64ToFloat32(b64);
    expect(back.length).toBe(input.length);
    for (let i = 0; i < input.length; i++) {
      expect(Math.abs(back[i] - input[i])).toBeLessThan(1 / 32767);
    }
  });
});

describe("downmixToMono", () => {
  it("passes through mono (returns a copy)", () => {
    const input = Float32Array.from([1, 2, 3]);
    const out = downmixToMono(input, 1);
    expect(Array.from(out)).toEqual([1, 2, 3]);
    expect(out).not.toBe(input); // copy, not same reference
  });

  it("averages stereo channels", () => {
    // interleaved stereo: [L0, R0, L1, R1]
    const input = Float32Array.from([0.2, 0.6, -0.4, 0.8]);
    const out = downmixToMono(input, 2);
    expect(out.length).toBe(2);
    expect(out[0]).toBeCloseTo(0.4, 6); // (0.2+0.6)/2
    expect(out[1]).toBeCloseTo(0.2, 6); // (-0.4+0.8)/2
  });

  it("handles 4-channel input", () => {
    const input = Float32Array.from([1, 1, 1, 1, 2, 2, 2, 2]);
    const out = downmixToMono(input, 4);
    expect(out.length).toBe(2);
    expect(out[0]).toBeCloseTo(1, 6);
    expect(out[1]).toBeCloseTo(2, 6);
  });

  it("handles empty input", () => {
    expect(downmixToMono(new Float32Array(0), 2).length).toBe(0);
  });
});
