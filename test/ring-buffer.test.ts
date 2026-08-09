import { describe, it, expect } from "vitest";
import { RingBuffer } from "../src/whatsapp/ring-buffer.js";

describe("RingBuffer", () => {
  it("starts empty", () => {
    const rb = new RingBuffer(100);
    expect(rb.length).toBe(0);
    expect(rb.capacity).toBe(100);
  });

  it("maintains FIFO order on simple push/pull", () => {
    const rb = new RingBuffer(100);
    const data = Float32Array.from([1, 2, 3, 4, 5]);
    rb.push(data);
    expect(rb.length).toBe(5);
    const out = rb.pull(5);
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5]);
    expect(rb.length).toBe(0);
  });

  it("pulls fewer samples on underflow and tracks underflow", () => {
    const rb = new RingBuffer(100);
    rb.push(Float32Array.from([1, 2]));
    const out = rb.pull(5);
    // Only 2 available; rest is zero-filled.
    expect(out.length).toBe(5);
    expect(out[0]).toBe(1);
    expect(out[1]).toBe(2);
    expect(out[2]).toBe(0);
    expect(out[3]).toBe(0);
    expect(out[4]).toBe(0);
    expect(rb.underflowSamples).toBe(3);
  });

  it("reports full underflow when pulling from empty buffer", () => {
    const rb = new RingBuffer(100);
    const out = rb.pull(10);
    expect(out.length).toBe(10);
    for (let i = 0; i < 10; i++) expect(out[i]).toBe(0);
    expect(rb.underflowSamples).toBe(10);
  });

  it("drops oldest samples on overflow (wrap-around)", () => {
    const rb = new RingBuffer(5);
    rb.push(Float32Array.from([1, 2, 3, 4, 5])); // fill
    expect(rb.length).toBe(5);
    // Push 3 more — oldest 3 (1,2,3) should be dropped.
    rb.push(Float32Array.from([6, 7, 8]));
    expect(rb.droppedSamples).toBe(3);
    // Buffer should now contain 4,5,6,7,8.
    const out = rb.pull(5);
    expect(Array.from(out)).toEqual([4, 5, 6, 7, 8]);
  });

  it("handles overflow where input exceeds capacity (replace entire buffer)", () => {
    const rb = new RingBuffer(3);
    rb.push(Float32Array.from([1, 2, 3]));
    // Input larger than capacity — buffer keeps last `capacity` samples.
    rb.push(Float32Array.from([10, 20, 30, 40, 50]));
    expect(rb.droppedSamples).toBe(2); // 10, 20 dropped
    const out = rb.pull(3);
    expect(Array.from(out)).toEqual([30, 40, 50]);
  });

  it("handles multiple wrap-around cycles preserving order", () => {
    const rb = new RingBuffer(4);
    for (let cycle = 0; cycle < 5; cycle++) {
      const base = cycle * 4;
      rb.push(Float32Array.from([base + 1, base + 2, base + 3, base + 4]));
      const out = rb.pull(4);
      expect(Array.from(out)).toEqual([base + 1, base + 2, base + 3, base + 4]);
    }
    expect(rb.droppedSamples).toBe(0);
    expect(rb.underflowSamples).toBe(0);
  });

  it("clear() resets state and stats", () => {
    const rb = new RingBuffer(10);
    rb.push(Float32Array.from([1, 2, 3]));
    rb.pull(5); // cause some underflow
    rb.clear();
    expect(rb.length).toBe(0);
    expect(rb.droppedSamples).toBe(0);
    expect(rb.underflowSamples).toBe(0);
  });

  it("supports partial pulls then continuation", () => {
    const rb = new RingBuffer(100);
    rb.push(Float32Array.from([10, 20, 30, 40, 50, 60]));
    const a = rb.pull(3);
    expect(Array.from(a)).toEqual([10, 20, 30]);
    expect(rb.length).toBe(3);
    rb.push(Float32Array.from([70, 80]));
    const b = rb.pull(5);
    expect(Array.from(b)).toEqual([40, 50, 60, 70, 80]);
    expect(rb.length).toBe(0);
  });

  it("pull into provided out buffer when large enough", () => {
    const rb = new RingBuffer(100);
    rb.push(Float32Array.from([1, 2, 3]));
    const out = new Float32Array(3);
    const result = rb.pull(3, out);
    expect(result).toBe(out);
    expect(Array.from(out)).toEqual([1, 2, 3]);
  });
});
