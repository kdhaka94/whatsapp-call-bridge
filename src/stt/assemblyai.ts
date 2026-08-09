/**
 * AssemblyAI streaming STT provider.
 *
 * Real-time transcription via AssemblyAI's Universal Streaming WebSocket API.
 * Audio is sent as binary PCM frames (16 kHz, 16-bit mono) — no base64.
 *
 * Protocol (v3):
 * - Connect to wss://streaming.assemblyai.com/v3/ws with Authorization header
 * - Server sends { type: "Begin" }
 * - Client sends binary PCM frames (~50ms chunks)
 * - Server sends { type: "Turn", end_of_turn: false, text: "..." } for partials
 * - Server sends { type: "Turn", end_of_turn: true, text: "..." } for finals
 * - Client sends { type: "Terminate" } to end
 *
 * Requires ASSEMBLYAI_API_KEY.
 */
import { WebSocket } from "ws";
import type { SttProvider, SttCallbacks } from "./types.js";
import { float32ToInt16 } from "../audio/pcm.js";

export type AssemblyAISttOptions = {
  apiKey?: string;
  /** Speech model: "universal-3.5-pro" | "universal-3-pro" | "universal-streaming-en" | "universal-streaming-multi" | "whisper-streaming". Default: "universal-3.5-pro" */
  speechModel?: string;
  /** Language code for multilingual models. Default: "en" */
  language?: string;
  /** WebSocket factory (for tests). */
  webSocketFactory?: (url: string, headers: Record<string, string>) => any;
  /** Connect timeout ms. Default: 10000 */
  connectTimeoutMs?: number;
};

const DEFAULT_URL = "wss://streaming.assemblyai.com/v3/ws";
const DEFAULT_MODEL = "universal-3.5-pro";

export class AssemblyAIStt implements SttProvider {
  #ws: any = null;
  #callbacks: SttCallbacks | null = null;
  #connectTimer: NodeJS.Timeout | null = null;
  #stopped = false;
  #opts: AssemblyAISttOptions;

  constructor(opts: AssemblyAISttOptions = {}) {
    this.#opts = opts;
  }

  start = (callbacks: SttCallbacks): Promise<void> => new Promise<void>((resolve, reject) => {
    const apiKey = this.#opts.apiKey ?? process.env.ASSEMBLYAI_API_KEY;
    if (!apiKey) { reject(new Error("AssemblyAI API key required (set ASSEMBLYAI_API_KEY or pass apiKey)")); return; }

    const model = this.#opts.speechModel ?? DEFAULT_MODEL;
    const params = new URLSearchParams({ speech_model: model });
    if (this.#opts.language) params.set("language", this.#opts.language);
    const url = `${DEFAULT_URL}?${params}`;

    const factory = this.#opts.webSocketFactory ?? ((u: string, headers: Record<string, string>) =>
      new WebSocket(u, { headers }));

    this.#callbacks = callbacks;
    this.#ws = factory(url, { Authorization: apiKey });

    const timeout = this.#opts.connectTimeoutMs ?? 10_000;
    this.#connectTimer = setTimeout(() => {
      if (!this.#stopped) reject(new Error(`AssemblyAI connect timeout after ${timeout}ms`));
    }, timeout);

    this.#ws.on("open", () => { /* ready to receive audio */ });

    this.#ws.on("message", (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        this.#handleMessage(msg, resolve);
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
        callbacks.onError?.(new Error(`AssemblyAI WebSocket closed: ${code} ${reason.toString()}`));
      }
    });
  });

  feedAudio = (pcm: Float32Array): void => {
    if (!this.#ws || this.#ws.readyState !== 1 || this.#stopped) return;
    // Send as binary Int16 LE PCM (no base64, no JSON wrapper).
    const int16 = float32ToInt16(pcm);
    this.#ws.send(int16, { binary: true });
  };

  stop = async (): Promise<void> => {
    this.#stopped = true;
    if (this.#connectTimer) { clearTimeout(this.#connectTimer); this.#connectTimer = null; }
    if (this.#ws && this.#ws.readyState === 1) {
      try { this.#ws.send(JSON.stringify({ type: "Terminate" })); } catch {}
      try { this.#ws.close(1000, "client stopped"); } catch {}
    }
  };

  #handleMessage = (msg: any, resolve: () => void): void => {
    switch (msg.type) {
      case "Begin":
        if (this.#connectTimer) { clearTimeout(this.#connectTimer); this.#connectTimer = null; }
        resolve();
        break;
      case "Turn":
        if (msg.end_of_turn) this.#callbacks?.onFinal?.(msg.text ?? "");
        else this.#callbacks?.onPartial?.(msg.text ?? "");
        break;
      case "Error":
      case "error":
        this.#callbacks?.onError?.(new Error(msg.error?.message ?? msg.message ?? "AssemblyAI error"));
        break;
      // SpeechStarted, Termination, Heartbeat — ignore
    }
  };
}
