/**
 * Test helpers: mock WhatsApp client, mock ActiveCall, and a mock WebSocket
 * for ElevenLabs bridge integration tests.
 */
import { EventEmitter } from "node:events";
import { ElevenLabsBridge, type WebSocketLike } from "../../src/elevenlabs/bridge.js";
import type { WhatsAppClientLike } from "../../src/client.js";

/**
 * Mock ActiveCall — an EventEmitter that simulates the WhatsApp call lifecycle.
 * Test drives it by calling `emitRinging()`, `emitConnected()`, `emitAudio()`,
 * `emitEnded()`. Records `pushAudio` and `flushAudio` calls for assertions.
 */
export class MockActiveCall extends EventEmitter {
  callId = "mock-call-id";
  pushAudioCalls: Float32Array[] = [];
  flushAudioCalls = 0;
  endCalls = 0;
  muteCalls: boolean[] = [];
  private endResolver!: (reason: string) => void;
  private endPromise: Promise<string>;

  constructor() {
    super();
    this.endPromise = new Promise((res) => { this.endResolver = res; });
  }

  pushAudio = (pcm: Float32Array): void => { this.pushAudioCalls.push(pcm); };
  flushAudio = (): void => { this.flushAudioCalls += 1; };
  end = (): void => { this.endCalls += 1; };
  mute = (muted: boolean): void => { this.muteCalls.push(muted); };
  waitForEnd = (): Promise<string> => this.endPromise;

  // Test drivers
  emitRinging = (): void => this.emit("ringing");
  emitConnected = (): void => this.emit("connected");
  emitAudio = (pcm: Float32Array): void => this.emit("audio", pcm);
  emitEnded = (reason: string): void => { this.emit("ended", reason); this.endResolver(reason); };
  emitError = (err: Error): void => this.emit("error", err);
}

/**
 * Mock WhatsApp client — returns a MockActiveCall from `call()`.
 */
export class MockWhatsAppClient implements WhatsAppClientLike {
  calls: { number: string; opts: any }[] = [];
  lastCall: MockActiveCall | null = null;
  connected = false;
  disconnected = false;

  connect = async (): Promise<void> => { this.connected = true; };
  call = async (phoneNumber: string, opts: any): Promise<MockActiveCall> => {
    this.calls.push({ number: phoneNumber, opts });
    const call = new MockActiveCall();
    this.lastCall = call;
    return call;
  };
  disconnect = (): void => { this.disconnected = true; };
}

/**
 * Mock WebSocket for ElevenLabs bridge (same pattern as bridge.test.ts but
 * exported here for integration tests).
 */
export class MockWebSocket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  private listeners = new Map<string, Array<(...args: any[]) => void>>();

  serverOpen(): void { this.readyState = 1; this.emit("open"); }
  serverSend(text: string): void { this.emit("message", text); }
  serverClose(code = 1000, reason = ""): void { this.readyState = 3; this.emit("close", code, reason); }
  serverError(err: Error): void { this.emit("error", err); }

  send(data: string): void { this.sent.push(data); }
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
  removeAllListeners(event?: string): this {
    if (event) this.listeners.delete(event); else this.listeners.clear();
    return this;
  }
  private emit(event: string, ...args: any[]): void {
    for (const l of this.listeners.get(event) ?? []) l(...args);
  }
}

/** Helper: create an ElevenLabs bridge backed by a MockWebSocket. */
export const createMockBridge = (mock: MockWebSocket): ElevenLabsBridge => {
  return new ElevenLabsBridge({
    agentId: "test-agent",
    webSocketFactory: () => mock,
  });
};

/** Helper: send the conversation_initiation_metadata to complete bridge.connect(). */
export const sendInitMetadata = (mock: MockWebSocket, overrides: any = {}): void => {
  mock.serverSend(JSON.stringify({
    type: "conversation_initiation_metadata",
    conversation_initiation_metadata_event: {
      conversation_id: "conv_test",
      agent_output_audio_format: "pcm_16000",
      user_input_audio_format: "pcm_16000",
      ...overrides,
    },
  }));
};

/** Helper: send an audio event with Float32 samples encoded as base64. */
export const sendAudioEvent = (mock: MockWebSocket, pcm: Float32Array): void => {
  const int16 = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    int16.writeInt16LE(s <= -1 ? -32768 : Math.round(s * 32767), i * 2);
  }
  mock.serverSend(JSON.stringify({
    type: "audio",
    audio_event: { audio_base_64: int16.toString("base64"), event_id: Math.random() },
  }));
};

/** Helper: send an interruption event. */
export const sendInterruption = (mock: MockWebSocket): void => {
  mock.serverSend(JSON.stringify({ type: "interruption", interruption_event: { event_id: 1 } }));
};

/** Helper: send a ping and return the event_id. */
export const sendPing = (mock: MockWebSocket, eventId = 1): void => {
  mock.serverSend(JSON.stringify({ type: "ping", ping_event: { event_id: eventId } }));
};

/** Helper: extract user_audio_chunk messages from sent data. */
export const extractUserAudioChunks = (sent: string[]): string[] => {
  return sent
    .map((s) => { try { return JSON.parse(s); } catch { return null; } })
    .filter((m) => m && m.user_audio_chunk !== undefined)
    .map((m) => m.user_audio_chunk);
};
