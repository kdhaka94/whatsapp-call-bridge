import { describe, it, expect, vi } from "vitest";
import { AssemblyAIStt } from "../src/stt/assemblyai.js";
import { DeepgramStt } from "../src/stt/deepgram.js";
import { WhisperStt } from "../src/stt/whisper.js";
import { float32ToInt16 } from "../src/audio/pcm.js";

// ─── Mock WebSocket for streaming STT ──────────────────────────────────────────
class MockSttWebSocket {
  readyState = 0;
  sent: Buffer[] = [];
  sentText: string[] = [];
  private listeners = new Map<string, Array<(...args: any[]) => void>>();

  serverOpen(): void { this.readyState = 1; this.emit("open"); }
  serverSendJSON(obj: any): void { this.emit("message", Buffer.from(JSON.stringify(obj))); }
  serverClose(code = 1000, reason = ""): void { this.readyState = 3; this.emit("close", code, reason); }
  serverError(err: Error): void { this.emit("error", err); }

  send(data: any, opts?: any): void {
    if (typeof data === "string") this.sentText.push(data);
    else if (Buffer.isBuffer(data)) this.sent.push(data);
  }
  close(code?: number, reason?: string): void { this.readyState = 3; this.emit("close", code ?? 1000, reason ?? ""); }
  on(event: string, listener: (...args: any[]) => void): this {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event)!.push(listener);
    return this;
  }
  off(event: string, listener: (...args: any[]) => void): this {
    const arr = this.listeners.get(event);
    if (arr) { const i = arr.indexOf(listener); if (i >= 0) arr.splice(i, 1); }
    return this;
  }
  private emit(event: string, ...args: any[]): void {
    for (const l of this.listeners.get(event) ?? []) l(...args);
  }
}

// ─── AssemblyAI ─────────────────────────────────────────────────────────────────
describe("AssemblyAIStt", () => {
  it("requires an API key", async () => {
    const stt = new AssemblyAIStt({ apiKey: undefined, webSocketFactory: () => new MockSttWebSocket() });
    await expect(stt.start({})).rejects.toThrow(/API key/i);
  });

  it("connects and receives partial + final transcripts", async () => {
    const mock = new MockSttWebSocket();
    const stt = new AssemblyAIStt({ apiKey: "test-key", webSocketFactory: () => mock });

    const partials: string[] = [];
    const finals: string[] = [];
    const startP = stt.start({ onPartial: (t) => partials.push(t), onFinal: (t) => finals.push(t) });

    mock.serverOpen();
    mock.serverSendJSON({ type: "Begin" });
    await startP;

    mock.serverSendJSON({ type: "Turn", end_of_turn: false, text: "hello" });
    mock.serverSendJSON({ type: "Turn", end_of_turn: false, text: "hello world" });
    mock.serverSendJSON({ type: "Turn", end_of_turn: true, text: "hello world" });

    expect(partials).toEqual(["hello", "hello world"]);
    expect(finals).toEqual(["hello world"]);

    await stt.stop();
    // Should have sent a Terminate message.
    expect(mock.sentText.some((s) => s.includes("Terminate"))).toBe(true);
  });

  it("sends binary PCM audio frames", async () => {
    const mock = new MockSttWebSocket();
    const stt = new AssemblyAIStt({ apiKey: "test-key", webSocketFactory: () => mock });
    const startP = stt.start({});
    mock.serverOpen();
    mock.serverSendJSON({ type: "Begin" });
    await startP;

    const pcm = Float32Array.from([0.5, -0.5, 0.25]);
    stt.feedAudio(pcm);

    expect(mock.sent.length).toBe(1);
    // Binary frame should be Int16 LE PCM.
    const sent = mock.sent[0];
    expect(sent.readInt16LE(0)).toBeGreaterThan(0); // 0.5 * 32767
    await stt.stop();
  });

  it("emits error on server error messages", async () => {
    const mock = new MockSttWebSocket();
    const stt = new AssemblyAIStt({ apiKey: "test-key", webSocketFactory: () => mock });
    const errors: Error[] = [];
    const startP = stt.start({ onError: (e) => errors.push(e) });
    mock.serverOpen();
    mock.serverSendJSON({ type: "Begin" });
    await startP;

    mock.serverSendJSON({ type: "Error", error: { message: "rate limited" } });
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("rate limited");
    await stt.stop();
  });
});

// ─── Deepgram ───────────────────────────────────────────────────────────────────
describe("DeepgramStt", () => {
  it("requires an API key", async () => {
    const stt = new DeepgramStt({ apiKey: undefined, webSocketFactory: () => new MockSttWebSocket() });
    await expect(stt.start({})).rejects.toThrow(/API key/i);
  });

  it("connects on open and receives interim + final transcripts", async () => {
    const mock = new MockSttWebSocket();
    const stt = new DeepgramStt({ apiKey: "test-key", webSocketFactory: () => mock });

    const partials: string[] = [];
    const finals: string[] = [];
    const startP = stt.start({ onPartial: (t) => partials.push(t), onFinal: (t) => finals.push(t) });
    mock.serverOpen();
    await startP;

    mock.serverSendJSON({
      type: "Results",
      channel: { alternatives: [{ transcript: "hi" }], is_final: false },
    });
    mock.serverSendJSON({
      type: "Results",
      channel: { alternatives: [{ transcript: "hello there" }], is_final: true },
    });

    expect(partials).toEqual(["hi"]);
    expect(finals).toEqual(["hello there"]);
    await stt.stop();
  });

  it("sends binary PCM audio frames", async () => {
    const mock = new MockSttWebSocket();
    const stt = new DeepgramStt({ apiKey: "test-key", webSocketFactory: () => mock });
    const startP = stt.start({});
    mock.serverOpen();
    await startP;

    stt.feedAudio(Float32Array.from([0.3, -0.3]));
    expect(mock.sent.length).toBe(1);
    await stt.stop();
  });
});

// ─── Whisper (batch) ────────────────────────────────────────────────────────────
describe("WhisperStt", () => {
  it("requires an API key", async () => {
    const stt = new WhisperStt({ apiKey: undefined, chunkSeconds: 100 });
    const errors: Error[] = [];
    await stt.start({ onError: (e) => errors.push(e) });
    stt.feedAudio(Float32Array.from([0.1, 0.2, 0.3]));
    await stt.stop();
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].message).toMatch(/API key/i);
  });

  it("buffers audio and transcribes on stop (mocked fetch)", async () => {
    // Mock global fetch
    const originalFetch = global.fetch;
    let fetchedUrl = "";
    let fetchedBody: Buffer | null = null;
    global.fetch = (async (url: any, opts: any) => {
      fetchedUrl = url;
      fetchedBody = opts.body as Buffer;
      return new Response(JSON.stringify({ text: "hello world" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as any;

    try {
      const stt = new WhisperStt({ apiKey: "test-key", chunkSeconds: 100 }); // long chunk — won't trigger timer
      const finals: string[] = [];
      await stt.start({ onFinal: (t) => finals.push(t) });

      // Feed 1 second of audio (16000 samples).
      stt.feedAudio(new Float32Array(16000).fill(0.5));
      await stt.stop(); // triggers flush

      expect(fetchedUrl).toContain("/audio/transcriptions");
      expect(fetchedBody).not.toBeNull();
      // Body should contain "whisper-1" model field and WAV data.
      const bodyStr = fetchedBody!.toString("latin1");
      expect(bodyStr).toContain("whisper-1");
      expect(bodyStr).toContain("RIFF");
      expect(bodyStr).toContain("WAVE");
      expect(finals).toEqual(["hello world"]);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("uses Groq URL when GROQ_API_KEY is set", async () => {
    const originalFetch = global.fetch;
    const originalEnv = process.env.GROQ_API_KEY;
    process.env.GROQ_API_KEY = "groq-test-key";
    let fetchedUrl = "";
    global.fetch = (async (url: any) => {
      fetchedUrl = url;
      return new Response(JSON.stringify({ text: "test" }), { status: 200 });
    }) as any;

    try {
      const stt = new WhisperStt({ chunkSeconds: 100 });
      await stt.start({});
      stt.feedAudio(new Float32Array(16000).fill(0.1));
      await stt.stop();
      expect(fetchedUrl).toContain("api.groq.com");
    } finally {
      global.fetch = originalFetch;
      if (originalEnv) process.env.GROQ_API_KEY = originalEnv;
      else delete process.env.GROQ_API_KEY;
    }
  });
});
