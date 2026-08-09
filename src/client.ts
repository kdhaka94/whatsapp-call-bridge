/**
 * AgentCaller — the public orchestrator.
 *
 * Connects to WhatsApp (via the vendored WASM stack + PushAudioFeeder) and, per
 * call, opens an ElevenLabs agent WebSocket. It bridges audio bidirectionally:
 * - WhatsApp call `audio` event (16 kHz Float32) → ElevenLabs `user_audio_chunk`
 * - ElevenLabs `audio` event (decoded + resampled to 16 kHz Float32) →
 *   `call.pushAudio()` → PushAudioFeeder → WhatsApp uplink
 * - ElevenLabs `interruption` → `call.flushAudio()` (stop agent mid-word)
 *
 * Usage:
 *   const caller = new AgentCaller({ authDir, elevenlabs: { agentId } });
 *   await caller.connect();                    // QR on first run
 *   const session = await caller.call("+1234...");
 *   session.on("agentResponse", (text) => console.log("agent:", text));
 *   await session.end();
 *   await caller.disconnect();
 */
import { EventEmitter } from "node:events";
import { WhatsAppClient } from "./whatsapp/voip-client.js";
import { ElevenLabsBridge } from "./elevenlabs/bridge.js";
import type { AgentCallerConfig, CallSessionOptions, CallSessionEvents } from "./config.js";
import type { ActiveCall } from "baileys-caller";

/**
 * Minimal interface for the WhatsApp client used by AgentCaller.
 * Production uses `WhatsAppClient`; tests inject a mock implementing this.
 */
export interface WhatsAppClientLike {
  connect: () => Promise<void>;
  call: (phoneNumber: string, opts: { audioSource?: string; durationMs?: number }) => Promise<ActiveCall>;
  disconnect: () => void;
}

/**
 * Factory for creating an ElevenLabs bridge per call.
 * Tests can inject a factory that returns a bridge with a mock WebSocket.
 */
export type BridgeFactory = (opts: {
  agentId?: string;
  signedUrl?: string;
  resampler?: import("./audio/resampler.js").Resampler;
  initiationData?: Record<string, unknown>;
}) => ElevenLabsBridge;

export class CallSession extends EventEmitter {
  #call: ActiveCall;
  #bridge: ElevenLabsBridge;
  #ended = false;

  constructor(call: ActiveCall, bridge: ElevenLabsBridge) {
    super();
    this.#call = call;
    this.#bridge = bridge;
  }

  /** The underlying WhatsApp ActiveCall (for advanced use). */
  get activeCall(): ActiveCall { return this.#call; }

  /** The ElevenLabs bridge (for advanced use, e.g. sendContextualUpdate). */
  get bridge(): ElevenLabsBridge { return this.#bridge; }

  /** Mute/unmute the WhatsApp uplink (stops sending agent audio). */
  mute = (muted: boolean): void => { this.#call.mute(muted); };

  /** Hang up the call and close the agent session. */
  end = async (): Promise<void> => {
    if (this.#ended) return;
    this.#ended = true;
    this.#call.end();
    this.#bridge.close();
  };

  /** Resolves when the call ends (with the end reason). */
  waitForEnd = (): Promise<string> => this.#call.waitForEnd();

  /** @internal force-end from an error path. */
  _forceEnd = (reason: string): void => {
    if (this.#ended) return;
    this.#ended = true;
    this.emit("ended", reason);
  };
}

export class AgentCaller {
  #whatsapp: WhatsAppClientLike;
  #config: AgentCallerConfig;
  #bridgeFactory: BridgeFactory;

  constructor(config: AgentCallerConfig & {
    /** @internal Inject a mock WhatsApp client for testing. */
    _whatsappClient?: WhatsAppClientLike;
    /** @internal Inject a bridge factory for testing. */
    _bridgeFactory?: BridgeFactory;
  }) {
    this.#config = config;
    this.#whatsapp = config._whatsappClient ?? new WhatsAppClient({
      authDir: config.authDir,
      feederOptions: {
        bufferSeconds: config.feederBufferSeconds,
        debug: config.feederDebug,
      },
    });
    this.#bridgeFactory = config._bridgeFactory ?? ((opts) => new ElevenLabsBridge(opts));
  }

  /** Connect to WhatsApp (prints a QR on first run). */
  connect = async (): Promise<void> => { await this.#whatsapp.connect(); };

  /**
   * Place an outbound WhatsApp call and connect it to the ElevenLabs agent.
   * Resolves once the call is placed (ringing). Listen to session events for
   * `connected`, `transcript`, `agentResponse`, `ended`, etc.
   */
  call = async (phoneNumber: string, opts: CallSessionOptions = {}): Promise<CallSession> => {
    const normalized = phoneNumber.replace(/\D/g, "");
    const durationMs = opts.durationMs ?? 120_000;

    // Open the ElevenLabs bridge first so it's ready when the call connects.
    const bridge = this.#bridgeFactory({
      agentId: this.#config.elevenlabs.agentId,
      signedUrl: this.#config.elevenlabs.signedUrl,
      resampler: this.#config.resampler,
      initiationData: opts.dynamicVariables
        ? { dynamic_variables: opts.dynamicVariables }
        : this.#config.elevenlabs.initiationData as any,
    });
    await bridge.connect();

    // Place the WhatsApp call with silence as the uplink (we push agent audio).
    const call = await this.#whatsapp.call(normalized, { audioSource: "silence", durationMs });
    const session = new CallSession(call, bridge);

    // ─── WhatsApp → ElevenLabs (user audio) ────────────────────────────────
    call.on("audio", (pcm: Float32Array) => {
      // pcm is 16 kHz mono Float32 from the remote peer — send as user audio.
      bridge.sendUserAudio(pcm);
    });

    // ─── ElevenLabs → WhatsApp (agent TTS) ─────────────────────────────────
    bridge.on("audio", (pcm: Float32Array) => {
      call.pushAudio(pcm);
    });

    // ─── ElevenLabs interruption → flush feeder (stop agent mid-word) ──────
    bridge.on("interruption", () => {
      call.flushAudio();
      session.emit("interruption");
    });

    // ─── Bridge events → session events ────────────────────────────────────
    bridge.on("transcript", (text: string) => session.emit("transcript", text));
    bridge.on("tentativeTranscript", (text: string, isFinal: boolean) =>
      session.emit("tentativeTranscript", text, isFinal));
    bridge.on("agentResponse", (text: string) => session.emit("agentResponse", text));
    bridge.on("agentResponseCorrection", (original: string, corrected: string) =>
      session.emit("agentResponseCorrection", original, corrected));
    bridge.on("error", (err: Error) => session.emit("error", err));

    // ─── WhatsApp call lifecycle → session events ──────────────────────────
    call.on("ringing", () => session.emit("ringing"));
    call.on("connected", () => session.emit("connected"));
    call.on("ended", (reason: string) => {
      bridge.close();
      session._forceEnd(reason);
    });
    call.on("error", (err: Error) => {
      bridge.close();
      session.emit("error", err);
      session._forceEnd("error");
    });

    return session;
  };

  /** Disconnect from WhatsApp and release all resources. */
  disconnect = (): void => { this.#whatsapp.disconnect(); };
}
