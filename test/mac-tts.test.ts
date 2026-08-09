import { describe, it, expect } from "vitest";
import { MacTtsSource } from "../src/audio/mac-tts.js";

const isMac = process.platform === "darwin";
const describeOrSkip = isMac ? describe : describe.skip;

describeOrSkip("MacTtsSource", { timeout: 30_000 }, () => {
  it("streams Float32 PCM chunks from `say`", async () => {
    const tts = new MacTtsSource();
    const chunks: Float32Array[] = [];

    await tts.speak("Hello world, this is a test.", { rate: 200 }, {
      onChunk: (pcm) => chunks.push(pcm),
    });

    // We should have received at least one chunk.
    expect(chunks.length).toBeGreaterThan(0);

    // All chunks should be Float32Array with reasonable sample values.
    const allSamples = chunks.flatMap((c) => Array.from(c));
    expect(allSamples.length).toBeGreaterThan(100); // at least some audio

    // Values should be in [-1, 1] range (Float32 PCM).
    const maxAbs = Math.max(...allSamples.map(Math.abs));
    expect(maxAbs).toBeGreaterThan(0.01); // actual audio, not silence
    expect(maxAbs).toBeLessThanOrEqual(1.0);
  });

  it("respects the voice option", async () => {
    const tts = new MacTtsSource();
    const chunks: Float32Array[] = [];

    // Use "Alex" voice — should still produce audio.
    await tts.speak("Testing voice selection.", { voice: "Alex", rate: 220 }, {
      onChunk: (pcm) => chunks.push(pcm),
    });

    expect(chunks.length).toBeGreaterThan(0);
  });

  it("handles empty text gracefully (resolves immediately)", async () => {
    const tts = new MacTtsSource();
    let chunksReceived = 0;

    await tts.speak("   ", {}, {
      onChunk: () => chunksReceived++,
    });

    expect(chunksReceived).toBe(0);
  });

  it("stop() kills processes without hanging", async () => {
    const tts = new MacTtsSource();
    let received = 0;

    // Start a long utterance, then stop it mid-stream.
    const longText = "This is a very long sentence that will take several seconds to speak so we can interrupt it in the middle.";
    const promise = tts.speak(longText, { rate: 100 }, {
      onChunk: () => received++,
    });

    // Give it a moment to start, then stop.
    await new Promise((r) => setTimeout(r, 500));
    tts.stop();

    // The promise should resolve without hanging (stop() calls finish()).
    await promise;
    expect(received).toBeGreaterThanOrEqual(0);
  });

  it("listVoices() returns available macOS voices", () => {
    const voices = MacTtsSource.listVoices();
    expect(voices.length).toBeGreaterThan(0);
    // Should include at least one English voice.
    const hasEnglish = voices.some((v) => v.locale.startsWith("en"));
    expect(hasEnglish).toBe(true);
    // Each voice should have a name and locale.
    for (const v of voices) {
      expect(v.name).toBeTruthy();
      expect(v.locale).toBeTruthy();
    }
  });
});
