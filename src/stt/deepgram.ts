/**
 * Deepgram streaming STT provider.
 *
 * Real-time transcription via Deepgram's WebSocket API.
 * Audio is sent as binary PCM frames (linear16 = 16-bit signed LE, 16 kHz mono).
 *
 * Protocol:
 * - Connect to wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=16000&interim_results=true
 * - Auth via Authorization: Token <api_key> header
 * - Client sends binary PCM frames
 * - Server sends JSON: { type: "Results", channel: { alternatives: [{ transcript }], is_final } }
 *
 * Requires DEEPGRAM_API_KEY.
 */
import { WebSocket } from "ws";
import type { SttProvider, SttCallbacks } from "./types.js";
import { float32ToInt16 } from "../audio/pcm.js";

export type DeepgramSttOptions = {
  apiKey?: string;
  /** Model: "nova-3" | "nova-2" | "flux-general-en" | "flux-general-multi" | "base" | "enhanced". Default: "nova-3" */
  model?: string;
  /** Language code. Default: "en" */
  language?: string;
  /** Enable interim/partial results. Default: true */
  interimResults?: boolean;
  /** Endpointing in ms (silence detection for turn boundaries). Default: 300 */
  endpointing?: number;
  /** WebSocket factory (for tests). */
  webSocketFactory?: (url: string, headers: Record<string, string>) => any;
  /** Connect timeout ms. Default: 10000 */
  connectTimeoutMs?: number;
};

const BASE_URL = "wss://api.deepgram.com/v1/listen";
const DEFAULT_MODEL = "nova-3";

export class DeepgramStt implements SttProvider {
  #ws: any = null;
  #callbacks: SttCallbacks | null = null;
  #connectTimer: NodeJS.Timeout | null = null;
  #stopped = false;
  #opts: DeepgramSttOptions;

  constructor(opts: DeepgramSttOptions = {}) {
    this.#opts = opts;
  }

  start = (callbacks: SttCallbacks): Promise<void> => new Promise<void>((resolve, reject) => {
    const apiKey = this.#opts.apiKey ?? process.env.DEEPGRAM_API_KEY;
    if (!apiKey) { reject(new Error("Deepgram API key required (set DEEPGRAM_API_KEY or pass apiKey)")); return; }

    const params = new URLSearchParams({
      model: this.#opts.model ?? DEFAULT_MODEL,
      encoding: "linear16",
      sample_rate: "16000",
      channels: "1",
      interim_results: String(this.#opts.interimResults ?? true),
      endpointing: String(this.#opts.endpointing ?? 300),
    });
    if (this.#opts.language) params.set("language", this.#opts.language);
    const url = `${BASE_URL}?${params}`;

    const factory = this.#opts.webSocketFactory ?? ((u: string, headers: Record<string, string>) =>
      new WebSocket(u, { headers }));

    this.#callbacks = callbacks;
    this.#ws = factory(url, { Authorization: `Token ${apiKey}` });

    const timeout = this.#opts.connectTimeoutMs ?? 10_000;
    this.#connectTimer = setTimeout(() => {
      if (!this.#stopped) reject(new Error(`Deepgram connect timeout after ${timeout}ms`));
    }, timeout);

    // Deepgram resolves on first open — it doesn't send a "Begin" message.
    this.#ws.on("open", () => {
      if (this.#connectTimer) { clearTimeout(this.#connectTimer); this.#connectTimer = null; }
      resolve();
    });

    this.#ws.on("message", (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        this.#handleMessage(msg);
      } catch (err) {
        callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    });

    this.#ws.on("error", (err: Error) => {
      if (this.#connectTimer) { clearTimeout(this.#connectTimer); this.#connectTimer = null; }
      if (!this.#stopped) reject(err);
      else callbacks.onError?.(err);
    });

    this.#ws.on("close", (code: number, reason: Buffer) => {
      if (this.#connectTimer) { clearTimeout(this.#connectTimer); this.#connectTimer = null; }
      if (!this.#stopped && code !== 1000) {
        callbacks.onError?.(new Error(`Deepgram WebSocket closed: ${code} ${reason.toString()}`));
      }
    });
  });

  feedAudio = (pcm: Float32Array): void => {
    if (!this.#ws || this.#ws.readyState !== 1 || this.#stopped) return;
    const int16 = float32ToInt16(pcm);
    this.#ws.send(int16, { binary: true });
  };

  stop = async (): Promise<void> => {
    this.#stopped = true;
    if (this.#connectTimer) { clearTimeout(this.#connectTimer); this.#connectTimer = null; }
    // Send CloseStream marker to flush final results.
    if (this.#ws && this.#ws.readyState === 1) {
      try { this.#ws.send(JSON.stringify({ type: "CloseStream" })); } catch {}
      try { this.#ws.close(1000, "client stopped"); } catch {}
    }
  };

  #handleMessage = (msg: any): void => {
    if (msg.type === "Results") {
      const alt = msg.channel?.alternatives?.[0];
      if (!alt) return;
      const text = alt.transcript ?? "";
      if (!text) return;
      const isFinal = msg.channel?.is_final ?? false;
      if (isFinal) this.#callbacks?.onFinal?.(text);
      else this.#callbacks?.onPartial?.(text);
    } else if (msg.type === "Metadata") {
      // Connected metadata — ignore
    }
  };
}
