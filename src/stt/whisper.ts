/**
 * Whisper STT provider (batch/chunked).
 *
 * Uses OpenAI-compatible transcription API (works with OpenAI, Groq, or any
 * local Whisper server). Collects audio chunks, sends them as WAV every
 * `chunkSeconds` seconds, and returns the transcription.
 *
 * Not real-time — there's a delay of `chunkSeconds` per transcription round.
 * Best for post-call analysis or when streaming STT isn't available.
 *
 * Requires OPENAI_API_KEY (or GROQ_API_KEY for Groq).
 *
 * Env:
 *   OPENAI_API_KEY    OpenAI API key
 *   GROQ_API_KEY      Groq API key (alternative — faster + cheaper)
 *   WHISPER_BASE_URL  Custom base URL (e.g. http://localhost:8080 for local)
 *   WHISPER_MODEL     Model name (default: "whisper-1" for OpenAI, "whisper-large-v3" for Groq)
 */
import type { SttProvider, SttCallbacks } from "./types.js";
import { float32ToInt16 } from "../audio/pcm.js";

export type WhisperSttOptions = {
  apiKey?: string;
  /** Base URL. Default: https://api.openai.com/v1 (use https://api.groq.com/openai/v1 for Groq) */
  baseUrl?: string;
  /** Model name. Default: "whisper-1" */
  model?: string;
  /** Language code (e.g. "en", "es"). Default: auto-detect */
  language?: string;
  /** Collect this many seconds of audio before transcribing. Default: 3 */
  chunkSeconds?: number;
  /** Prompt to guide transcription. Optional */
  prompt?: string;
};

const SAMPLE_RATE = 16000;
const DEFAULT_CHUNK_SECONDS = 3;

export class WhisperStt implements SttProvider {
  #opts: WhisperSttOptions;
  #callbacks: SttCallbacks | null = null;
  #buffer: Float32Array[] = [];
  #bufferSamples = 0;
  #chunkTimer: NodeJS.Timeout | null = null;
  #stopped = false;
  #transcribing = false;

  constructor(opts: WhisperSttOptions = {}) {
    this.#opts = opts;
  }

  start = async (callbacks: SttCallbacks): Promise<void> => {
    this.#callbacks = callbacks;
    this.#stopped = false;
    const chunkSeconds = this.#opts.chunkSeconds ?? DEFAULT_CHUNK_SECONDS;
    this.#chunkTimer = setInterval(() => { void this.#flushChunk(); }, chunkSeconds * 1000);
  };

  feedAudio = (pcm: Float32Array): void => {
    if (this.#stopped) return;
    this.#buffer.push(pcm);
    this.#bufferSamples += pcm.length;
  };

  stop = async (): Promise<void> => {
    if (this.#chunkTimer) { clearInterval(this.#chunkTimer); this.#chunkTimer = null; }
    // Flush any remaining audio BEFORE setting stopped (so onFinal fires).
    await this.#flushChunk();
    this.#stopped = true;
  };

  #flushChunk = async (): Promise<void> => {
    if (this.#transcribing || this.#bufferSamples === 0) return;

    // Collect all buffered audio.
    const all = new Float32Array(this.#bufferSamples);
    let off = 0;
    for (const chunk of this.#buffer) { all.set(chunk, off); off += chunk.length; }
    this.#buffer = [];
    this.#bufferSamples = 0;

    this.#transcribing = true;
    try {
      const text = await this.#transcribe(all);
      if (text) this.#callbacks?.onFinal?.(text);
    } catch (err) {
      this.#callbacks?.onError?.(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.#transcribing = false;
    }
  };

  #transcribe = async (pcm: Float32Array): Promise<string> => {
    const apiKey = this.#opts.apiKey ?? process.env.OPENAI_API_KEY ?? process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error("API key required (set OPENAI_API_KEY or GROQ_API_KEY)");

    const baseUrl = this.#opts.baseUrl ?? process.env.WHISPER_BASE_URL ??
      (process.env.GROQ_API_KEY ? "https://api.groq.com/openai/v1" : "https://api.openai.com/v1");
    const model = this.#opts.model ?? process.env.WHISPER_MODEL ??
      (process.env.GROQ_API_KEY ? "whisper-large-v3" : "whisper-1");

    // Convert Float32 → Int16 → WAV.
    const int16 = float32ToInt16(pcm);
    const wav = this.#wrapWav(int16, SAMPLE_RATE);

    // Build multipart form.
    const boundary = `----calling-agent-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const parts: Buffer[] = [];

    // model field
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n`));
    // audio file field
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`));
    parts.push(wav);
    parts.push(Buffer.from("\r\n"));
    // language field (optional)
    if (this.#opts.language) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${this.#opts.language}\r\n`));
    }
    // prompt field (optional)
    if (this.#opts.prompt) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n${this.#opts.prompt}\r\n`));
    }
    // response_format
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n`));
    parts.push(Buffer.from(`--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    const resp = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`Whisper API error ${resp.status}: ${errText || resp.statusText}`);
    }

    const result = await resp.json() as { text?: string };
    return result.text ?? "";
  };

  /** Wrap raw Int16 LE PCM in a minimal WAV header. */
  #wrapWav = (pcm: Buffer, sampleRate: number): Buffer => {
    const dataLen = pcm.length;
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + dataLen, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);       // PCM fmt chunk size
    header.writeUInt16LE(1, 20);        // audio format = PCM
    header.writeUInt16LE(1, 22);        // mono
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28); // byte rate
    header.writeUInt16LE(2, 32);        // block align
    header.writeUInt16LE(16, 34);       // bits per sample
    header.write("data", 36);
    header.writeUInt32LE(dataLen, 40);
    return Buffer.concat([header, pcm]);
  };
}
