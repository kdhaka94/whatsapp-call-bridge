import { describe, it, expect, vi } from "vitest";
import { ElevenLabsBridge, type WebSocketLike } from "../src/elevenlabs/bridge.js";
import { float32ToInt16, base64ToFloat32, float32ToBase64 } from "../src/audio/pcm.js";

/**
 * Minimal in-memory WebSocket mock. The test drives it by calling
 * `serverSend(...)` to deliver messages and inspecting `sent` for what the
 * bridge sent. readyState mirrors ws (0=connecting, 1=open, 3=closed).
 */
class MockWebSocket implements WebSocketLike {
  readyState = 0; // connecting
  sent: string[] = [];
  private listeners = new Map<string, Array<(...args: any[]) => void>>();
  onOpen: () => void = () => {};

  // Test helpers
  serverOpen(): void {
    this.readyState = 1;
    this.emit("open");
  }
  serverSend(text: string): void {
    this.emit("message", text);
  }
  serverClose(code: number, reason: string): void {
    this.readyState = 3;
    this.emit("close", code, reason);
  }
  serverError(err: Error): void {
    this.emit("error", err);
  }

  // WebSocketLike impl
  send(data: string): void { this.sent.push(data); }
  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.emit("close", code ?? 1000, reason ?? "");
  }
  on(event: string, listener: (...args: any[]) => void): this {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event)!.push(listener);
    return this;
  }
  off(event: string, listener: (...args: any[]) => void): this {
    const arr = this.listeners.get(event);
    if (arr) {
      const i = arr.indexOf(listener);
      if (i >= 0) arr.splice(i, 1);
    }
    return this;
  }
  removeAllListeners(event?: string): this {
    if (event) this.listeners.delete(event);
    else this.listeners.clear();
    return this;
  }
  private emit(event: string, ...args: any[]): void {
    for (const l of this.listeners.get(event) ?? []) l(...args);
  }
}

const metadata = (overrides: Partial<{ conversation_id: string; agent_output_audio_format: any; user_input_audio_format: any }> = {}) => ({
  type: "conversation_initiation_metadata",
  conversation_initiation_metadata_event: {
    conversation_id: "conv_123",
    agent_output_audio_format: "pcm_16000",
    user_input_audio_format: "pcm_16000",
    ...overrides,
  },
});

describe("ElevenLabsBridge", () => {
  it("sends initiation on open and resolves connect on metadata", async () => {
    const mock = new MockWebSocket();
    const bridge = new ElevenLabsBridge({
      agentId: "agent_test",
      webSocketFactory: () => mock,
    });
    const initiated = vi.fn();
    bridge.on("initiated", initiated);

    const connectP = bridge.connect();
    mock.serverOpen();
    mock.serverSend(JSON.stringify(metadata()));
    await connectP;

    expect(initiated).toHaveBeenCalledWith("conv_123", "pcm_16000", "pcm_16000");
    expect(bridge.connected).toBe(true);
    expect(bridge.conversationId).toBe("conv_123");
    // First sent message should be the initiation.
    const first = JSON.parse(mock.sent[0]);
    expect(first.type).toBe("conversation_initiation_client_data");
  });

  it("decodes audio events to Float32 and emits with sample rate", async () => {
    const mock = new MockWebSocket();
    const bridge = new ElevenLabsBridge({ agentId: "a", webSocketFactory: () => mock });
    const audioChunks: Float32Array[] = [];
    bridge.on("audio", (pcm, rate) => { audioChunks.push(pcm); expect(rate).toBe(16000); });

    const connectP = bridge.connect();
    mock.serverOpen();
    mock.serverSend(JSON.stringify(metadata()));
    await connectP;

    const inputPcm = Float32Array.from([0, 0.5, -0.5, 1, -1]);
    const b64 = float32ToBase64(inputPcm);
    mock.serverSend(JSON.stringify({ type: "audio", audio_event: { audio_base_64: b64, event_id: 1 } }));

    expect(audioChunks).toHaveLength(1);
    expect(audioChunks[0].length).toBe(inputPcm.length);
    for (let i = 0; i < inputPcm.length; i++) {
      expect(Math.abs(audioChunks[0][i] - inputPcm[i])).toBeLessThan(1 / 32767);
    }
    bridge.close();
  });

  it("sends user audio as base64 user_audio_chunk with no type field", async () => {
    const mock = new MockWebSocket();
    const bridge = new ElevenLabsBridge({ agentId: "a", webSocketFactory: () => mock });
    const connectP = bridge.connect();
    mock.serverOpen();
    mock.serverSend(JSON.stringify(metadata()));
    await connectP;

    mock.sent.length = 0;
    const pcm = Float32Array.from([0.25, -0.25, 0.5]);
    bridge.sendUserAudio(pcm);

    expect(mock.sent).toHaveLength(1);
    const msg = JSON.parse(mock.sent[0]);
    expect(msg.user_audio_chunk).toBeDefined();
    expect(msg.type).toBeUndefined();
    // Decode and verify the round-trip.
    const decoded = base64ToFloat32(msg.user_audio_chunk);
    for (let i = 0; i < pcm.length; i++) {
      expect(Math.abs(decoded[i] - pcm[i])).toBeLessThan(1 / 32767);
    }
    bridge.close();
  });

  it("replies to ping with pong matching event_id", async () => {
    const mock = new MockWebSocket();
    const bridge = new ElevenLabsBridge({ agentId: "a", webSocketFactory: () => mock });
    const connectP = bridge.connect();
    mock.serverOpen();
    mock.serverSend(JSON.stringify(metadata()));
    await connectP;

    mock.sent.length = 0;
    mock.serverSend(JSON.stringify({ type: "ping", ping_event: { event_id: 42, stream_id: 7 } }));

    const pong = JSON.parse(mock.sent[0]);
    expect(pong.type).toBe("pong");
    expect(pong.event_id).toBe(42);
    expect(pong.stream_id).toBe(7);
    bridge.close();
  });

  it("emits interruption and resets resampler (caller flushes feeder)", async () => {
    const mock = new MockWebSocket();
    const bridge = new ElevenLabsBridge({ agentId: "a", webSocketFactory: () => mock });
    const onInterruption = vi.fn();
    bridge.on("interruption", onInterruption);

    const connectP = bridge.connect();
    mock.serverOpen();
    mock.serverSend(JSON.stringify(metadata()));
    await connectP;

    mock.serverSend(JSON.stringify({ type: "interruption", interruption_event: { event_id: 5 } }));
    expect(onInterruption).toHaveBeenCalledTimes(1);
    bridge.close();
  });

  it("emits transcript and agentResponse events", async () => {
    const mock = new MockWebSocket();
    const bridge = new ElevenLabsBridge({ agentId: "a", webSocketFactory: () => mock });
    const transcripts: string[] = [];
    const responses: string[] = [];
    bridge.on("transcript", (t) => transcripts.push(t));
    bridge.on("agentResponse", (t) => responses.push(t));

    const connectP = bridge.connect();
    mock.serverOpen();
    mock.serverSend(JSON.stringify(metadata()));
    await connectP;

    mock.serverSend(JSON.stringify({ type: "user_transcript", user_transcript_event: { transcript: "hello there", transcript_id: 1 } }));
    mock.serverSend(JSON.stringify({ type: "agent_response", agent_response_event: { response: "Hi! How can I help?", response_id: 2 } }));

    expect(transcripts).toEqual(["hello there"]);
    expect(responses).toEqual(["Hi! How can I help?"]);
    bridge.close();
  });

  it("resamples agent audio when output format is not 16 kHz", async () => {
    const mock = new MockWebSocket();
    const bridge = new ElevenLabsBridge({ agentId: "a", webSocketFactory: () => mock });
    const connectP = bridge.connect();
    mock.serverOpen();
    // Agent outputs at 48 kHz.
    mock.serverSend(JSON.stringify(metadata({ agent_output_audio_format: "pcm_48000" })));
    await connectP;
    expect(bridge.agentOutputFormat).toBe("pcm_48000");

    const audioChunks: { pcm: Float32Array; rate: number }[] = [];
    bridge.on("audio", (pcm, rate) => audioChunks.push({ pcm, rate }));

    // Send a chunk of 48k audio: 6 samples of a ramp [0,1,2,3,4,5].
    // 48k -> 16k downsamples to ~2 samples.
    const inputPcm = Float32Array.from([0, 1, 2, 3, 4, 5]);
    const b64 = float32ToBase64(inputPcm);
    mock.serverSend(JSON.stringify({ type: "audio", audio_event: { audio_base_64: b64, event_id: 1 } }));

    expect(audioChunks).toHaveLength(1);
    expect(audioChunks[0].rate).toBe(16000);
    // 6 input @ 48k → ~2 output @ 16k.
    expect(audioChunks[0].pcm.length).toBeGreaterThan(0);
    expect(audioChunks[0].pcm.length).toBeLessThan(inputPcm.length);
    bridge.close();
  });

  it("rejects connect on timeout", async () => {
    const mock = new MockWebSocket();
    const bridge = new ElevenLabsBridge({
      agentId: "a",
      webSocketFactory: () => mock,
      connectTimeoutMs: 50,
    });
    // Open the socket but never send metadata → timeout.
    const connectP = bridge.connect();
    mock.serverOpen();
    await expect(connectP).rejects.toThrow(/timeout/i);
  });

  it("emits error on client_error messages", async () => {
    const mock = new MockWebSocket();
    const bridge = new ElevenLabsBridge({ agentId: "a", webSocketFactory: () => mock });
    const errors: Error[] = [];
    bridge.on("error", (e) => errors.push(e));

    const connectP = bridge.connect();
    mock.serverOpen();
    mock.serverSend(JSON.stringify(metadata()));
    await connectP;

    mock.serverSend(JSON.stringify({ type: "client_error", error_event: { code: 400, error_name: "bad_request", message: "nope" } }));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("400");
    expect(errors[0].message).toContain("bad_request");
    bridge.close();
  });

  it("requires either agentId or signedUrl", () => {
    expect(() => new ElevenLabsBridge({})).toThrow(/agentId|signedUrl/i);
  });
});
