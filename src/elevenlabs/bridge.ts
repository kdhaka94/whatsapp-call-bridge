/**
 * ElevenLabsBridge — WebSocket client for ElevenLabs Conversational AI.
 *
 * Connects to the agent WebSocket, sends user audio (from the WhatsApp call) as
 * base64 `user_audio_chunk` messages, receives agent TTS audio as base64 `audio`
 * events (decoded + resampled to 16 kHz Float32), and emits typed events.
 *
 * Audio direction:
 * - User → Agent: `sendUserAudio(Float32Array)` → Int16 → base64 → WS
 *   (assumes input is 16 kHz mono Float32 from the WhatsApp `audio` event)
 * - Agent → User: WS `audio` event → base64 → Int16 → Float32 →
 *   `onAgentAudio(Float32Array, sampleRate)` callback (resampled to 16 kHz if
 *   the agent output format differs)
 *
 * Interruption: on an `interruption` event, calls `onInterruption()` so the
 * caller can flush the PushAudioFeeder (stop agent mid-word).
 */
import { EventEmitter } from "node:events";
import { WebSocket, type RawData } from "ws";
import {
  type ClientMessage,
  type ServerMessage,
  type AudioFormat,
  type ConversationInitiationClientData,
  parseServerMessage,
  sampleRateForFormat,
} from "./messages.js";
import { float32ToBase64, base64ToFloat32 } from "../audio/pcm.js";
import { StreamingResampler, type Resampler, linearResampler } from "../audio/resampler.js";

export type ElevenLabsBridgeOptions = {
  /** Agent ID (for public agents) OR a signed URL (for private agents). */
  agentId?: string;
  /** Signed URL for private agents (takes precedence over agentId). */
  signedUrl?: string;
  /** Optional initiation data (dynamic variables, config override, etc.). */
  initiationData?: Partial<ConversationInitiationClientData>;
  /** Custom resampler (default: linear). Used only if agent output ≠ 16 kHz. */
  resampler?: Resampler;
  /** WebSocket factory (for tests). Defaults to the `ws` package. */
  webSocketFactory?: (url: string) => WebSocketLike;
  /** Request timeout for the initial connection (ms). Default 15000. */
  connectTimeoutMs?: number;
};

/** Minimal WebSocket interface (matches `ws` and our mock). */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: RawData | string) => void): this;
  on(event: "close", listener: (code: number, reason: Buffer | string) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: string, listener: (...args: any[]) => void): this;
  off?(event: string, listener: (...args: any[]) => void): this;
  removeAllListeners?(event?: string): this;
}

export type BridgeEvents = {
  /** Agent audio chunk decoded + resampled to 16 kHz mono Float32. */
  audio: (pcm: Float32Array, sampleRate: number) => void;
  /** Conversation initialized — formats negotiated. */
  initiated: (conversationId: string, inputFormat: AudioFormat, outputFormat: AudioFormat) => void;
  /** Finalized user utterance transcript. */
  transcript: (text: string) => void;
  /** Tentative (partial) user transcript. */
  tentativeTranscript: (text: string, isFinal: boolean) => void;
  /** Complete agent text response. */
  agentResponse: (text: string) => void;
  /** Corrected agent text response. */
  agentResponseCorrection: (original: string, corrected: string) => void;
  /** User interrupted the agent (caller should flush the feeder). */
  interruption: () => void;
  /** WebSocket closed. */
  close: (code: number, reason: string) => void;
  /** Fatal error. */
  error: (err: Error) => void;
};

const DEFAULT_CONNECT_TIMEOUT = 15_000;
const USER_ACTIVITY_INTERVAL_MS = 30_000;
const TARGET_RATE = 16000; // WhatsApp uplink rate

export class ElevenLabsBridge extends EventEmitter {
  #ws: WebSocketLike | null = null;
  #resampler: StreamingResampler;
  #agentOutputFormat: AudioFormat | null = null;
  #userInputFormat: AudioFormat | null = null;
  #conversationId: string | null = null;
  #connected = false;
  #userActivityTimer: NodeJS.Timeout | null = null;
  #connectTimer: NodeJS.Timeout | null = null;
  #opts: ElevenLabsBridgeOptions;

  constructor(opts: ElevenLabsBridgeOptions) {
    super();
    if (!opts.agentId && !opts.signedUrl) {
      throw new Error("ElevenLabsBridge requires either agentId or signedUrl");
    }
    this.#opts = opts;
    this.#resampler = new StreamingResampler(opts.resampler ?? linearResampler);
  }

  get connected(): boolean { return this.#connected; }
  get conversationId(): string | null { return this.#conversationId; }
  get agentOutputFormat(): AudioFormat | null { return this.#agentOutputFormat; }
  get userInputFormat(): AudioFormat | null { return this.#userInputFormat; }

  /** Open the WebSocket and send the initiation message. Resolves on `initiated`. */
  connect = (): Promise<void> => new Promise<void>((resolve, reject) => {
    const url = this.#resolveUrl();
    const factory = this.#opts.webSocketFactory ?? ((u: string) => new WebSocket(u) as unknown as WebSocketLike);
    this.#ws = factory(url);

    const timeout = this.#opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT;
    this.#connectTimer = setTimeout(() => {
      if (!this.#connected) {
        this.#cleanup();
        reject(new Error(`ElevenLabs bridge connect timeout after ${timeout}ms`));
      }
    }, timeout);

    const onOpen = () => {
      this.#sendInitiation();
      this.#startUserActivityPings();
    };
    const onMessage = (data: RawData | string) => {
      try {
        const text = typeof data === "string" ? data : data.toString();
        const msg = parseServerMessage(JSON.parse(text));
        const done = this.#handleMessage(msg);
        if (done) resolve();
      } catch (err) {
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
      }
    };
    const onError = (err: Error) => {
      this.#cleanup();
      reject(err);
    };
    const onClose = (code: number, reason: Buffer | string) => {
      const reasonStr = typeof reason === "string" ? reason : reason.toString();
      this.#cleanup();
      this.emit("close", code, reasonStr);
      if (!this.#connected) reject(new Error(`WebSocket closed before initiation (code ${code}: ${reasonStr})`));
    };

    this.#ws!.on("open", onOpen);
    this.#ws!.on("message", onMessage);
    this.#ws!.on("error", onError);
    this.#ws!.on("close", onClose);
  });

  /** Send user audio (16 kHz mono Float32) to the agent as a base64 chunk. */
  sendUserAudio = (pcm: Float32Array): void => {
    if (!this.#ws || this.#ws.readyState !== 1 /* OPEN */) return;
    const b64 = float32ToBase64(pcm);
    this.#send({ user_audio_chunk: b64 } as ClientMessage);
  };

  /** Send a non-interrupting contextual update. */
  sendContextualUpdate = (text: string): void => {
    this.#send({ type: "contextual_update", text });
  };

  /** Inject text as if the user spoke it. */
  sendUserMessage = (text: string): void => {
    this.#send({ type: "user_message", text });
  };

  /** Close the WebSocket. */
  close = (): void => {
    this.#cleanup();
    this.#ws?.close(1000, "client closed");
  };

  // ─── private ──────────────────────────────────────────────────────────────

  #resolveUrl = (): string => {
    if (this.#opts.signedUrl) return this.#opts.signedUrl;
    if (!this.#opts.agentId) throw new Error("Either agentId or signedUrl is required");
    return `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${this.#opts.agentId}`;
  };

  #sendInitiation = (): void => {
    const init: ConversationInitiationClientData = {
      type: "conversation_initiation_client_data",
      ...this.#opts.initiationData,
    };
    this.#send(init);
  };

  #send = (msg: ClientMessage): void => {
    if (!this.#ws || this.#ws.readyState !== 1) return;
    // Audio chunks are sent bare ({user_audio_chunk: ...}) with no `type`.
    this.#ws.send(JSON.stringify(msg));
  };

  #startUserActivityPings = (): void => {
    this.#userActivityTimer = setInterval(() => {
      this.#send({ type: "user_activity" });
    }, USER_ACTIVITY_INTERVAL_MS);
  };

  #handleMessage = (msg: ServerMessage): boolean => {
    switch (msg.type) {
      case "conversation_initiation_metadata": {
        const e = msg.conversation_initiation_metadata_event;
        this.#conversationId = e.conversation_id;
        this.#agentOutputFormat = e.agent_output_audio_format;
        this.#userInputFormat = e.user_input_audio_format;
        this.#connected = true;
        if (this.#connectTimer) { clearTimeout(this.#connectTimer); this.#connectTimer = null; }
        this.emit("initiated", e.conversation_id, e.user_input_audio_format, e.agent_output_audio_format);
        return true; // resolves connect()
      }
      case "audio": {
        const pcm = base64ToFloat32(msg.audio_event.audio_base_64);
        const outRate = this.#agentOutputFormat ? sampleRateForFormat(this.#agentOutputFormat) : TARGET_RATE;
        const resampled = outRate === TARGET_RATE ? pcm : this.#resampler.processChunk(pcm, outRate, TARGET_RATE);
        this.emit("audio", resampled, TARGET_RATE);
        return false;
      }
      case "interruption": {
        this.#resampler.reset();
        this.emit("interruption");
        return false;
      }
      case "user_transcript": {
        this.emit("transcript", msg.user_transcript_event.transcript);
        return false;
      }
      case "tentative_user_transcript": {
        this.emit("tentativeTranscript", msg.tentative_user_transcript_event.transcript, msg.tentative_user_transcript_event.is_final);
        return false;
      }
      case "agent_response": {
        this.emit("agentResponse", msg.agent_response_event.response);
        return false;
      }
      case "agent_response_correction": {
        const e = msg.agent_response_correction_event;
        this.emit("agentResponseCorrection", e.original_response, e.corrected_response);
        return false;
      }
      case "ping": {
        const eventId = msg.ping_event?.event_id ?? msg.event_id ?? 0;
        const streamId = msg.ping_event?.stream_id;
        const pong: ClientMessage = { type: "pong", event_id: eventId };
        if (streamId !== undefined) (pong as any).stream_id = streamId;
        this.#send(pong);
        return false;
      }
      case "client_error": {
        const e = msg.error_event;
        this.emit("error", new Error(`ElevenLabs client_error ${e.code}: ${e.error_name}${e.message ? ` — ${e.message}` : ""}`));
        return false;
      }
      default: {
        // Unknown message type — ignore but don't crash.
        return false;
      }
    }
  };

  #cleanup = (): void => {
    if (this.#connectTimer) { clearTimeout(this.#connectTimer); this.#connectTimer = null; }
    if (this.#userActivityTimer) { clearInterval(this.#userActivityTimer); this.#userActivityTimer = null; }
    this.#connected = false;
  };
}
