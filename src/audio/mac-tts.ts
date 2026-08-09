/**
 * MacTtsSource — stream macOS built-in TTS (`say` command) into a WhatsApp call.
 *
 * Pipeline:
 *   1. `say -o <temp.wav> --data-format=LEF32@16000 "text"`  (generates 16k Float32 WAV — fast, faster than realtime)
 *   2. ffmpeg streams-decodes the WAV → f32le PCM on stdout → Float32Array chunks → onChunk
 *
 * The `PushAudioFeeder`'s jitter buffer absorbs the ~100-300ms generation gap
 * between utterances. For longer text, `say` generates proportionally faster
 * than playback, so the feeder stays fed.
 *
 * Usage with WhatsAppClient:
 *   const tts = new MacTtsSource();
 *   await tts.speak("Hello, how are you?", { voice: "Samantha" }, {
 *     onChunk: (pcm) => call.pushAudio(pcm),
 *   });
 *
 * macOS-only. `say` and `ffmpeg` must be on PATH.
 */
import { spawn, execSync, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, unlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type MacTtsOptions = {
  /** Voice name (e.g. "Samantha", "Daniel", "Alex", "Karen"). Default: system voice. */
  voice?: string;
  /** Speech rate in words per minute (default: 175). Range ~120-210. */
  rate?: number;
};

export type SpeakCallbacks = {
  /** Called for each Float32Array PCM chunk (16 kHz mono). */
  onChunk: (pcm: Float32Array) => void;
  /** Called when the utterance finishes (all audio flushed). */
  onEnd?: () => void;
  /** Called on a fatal error. */
  onError?: (err: Error) => void;
};

const TARGET_SAMPLE_RATE = 16000;
const FLOAT32_BYTES = 4;

export class MacTtsSource {
  #ffmpegProc: ChildProcessWithoutNullStreams | null = null;
  #meterTimer: NodeJS.Timeout | null = null;
  #tempFile: string | null = null;
  #stopped = false;
  #finishFn: (() => void) | null = null;

  /**
   * Speak text and stream the audio as Float32Array chunks.
   * Resolves when the entire utterance has been streamed (all chunks emitted).
   */
  speak = (text: string, options: MacTtsOptions = {}, callbacks: SpeakCallbacks): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      if (this.#stopped) { reject(new Error("MacTtsSource has been stopped")); return; }
      if (!text.trim()) { callbacks.onEnd?.(); resolve(); return; }

      // Create a temp file path for the WAV output.
      this.#tempFile = join(tmpdir(), `mac-tts-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);

      // Build the `say` command — output 16k Float32 WAV directly.
      const sayArgs = ["-o", this.#tempFile, "--data-format=LEF32@16000", "--channels=1", "--file-format=WAVE"];
      if (options.voice) sayArgs.push("-v", options.voice);
      if (options.rate) sayArgs.push("-r", String(options.rate));
      sayArgs.push(text);

      // Step 1: generate the WAV file with `say` (synchronous — fast, faster than realtime).
      try {
        execFileSync("say", sayArgs, { stdio: ["pipe", "ignore", "pipe"] });
      } catch (err: any) {
        const msg = err.message || String(err);
        if (msg.includes("ENOENT")) {
          reject(new Error("`say` command not found. macOS TTS requires macOS with the `say` command."));
        } else if (msg.includes("unrecognized")) {
          // Older macOS may not support --data-format; fall back to default AIFF.
          try {
            execFileSync("say", ["-o", this.#tempFile, ...(options.voice ? ["-v", options.voice] : []), ...(options.rate ? ["-r", String(options.rate)] : []), text], { stdio: ["pipe", "ignore", "pipe"] });
          } catch (err2: any) {
            this.#cleanup();
            reject(new Error(`say failed: ${err2.message || err2}`));
            return;
          }
        } else {
          this.#cleanup();
          reject(new Error(`say failed: ${msg}`));
          return;
        }
      }

      if (this.#stopped) { this.#cleanup(); resolve(); return; }
      if (!existsSync(this.#tempFile)) {
        reject(new Error("say did not produce an output file"));
        return;
      }

      // Step 2: stream-decode the WAV with ffmpeg → f32le PCM on stdout.
      // Collect ALL audio first, then meter it out at real-time pace so the
      // PushAudioFeeder's ring buffer doesn't overflow and drop samples.
      // (say + ffmpeg generate audio much faster than realtime; without
      // pacing, the entire utterance would be dumped into the feeder instantly
      // and only the last ~2 seconds would survive the buffer overflow.)
      const ffmpegArgs = [
        "-hide_banner", "-loglevel", "error",
        "-i", this.#tempFile,
        "-f", "f32le", "-ac", "1", "-ar", String(TARGET_SAMPLE_RATE),
        "pipe:1",
      ];

      this.#ffmpegProc = spawn("ffmpeg", ffmpegArgs);

      const allAudio: Buffer[] = [];
      let resolved = false;

      const finish = (err?: Error) => {
        if (resolved) return;
        resolved = true;
        this.#finishFn = null;
        if (this.#meterTimer) { clearInterval(this.#meterTimer); this.#meterTimer = null; }
        this.#cleanup();
        if (err) { callbacks.onError?.(err); reject(err); }
        else { callbacks.onEnd?.(); resolve(); }
      };
      this.#finishFn = () => finish();

      // Collect all ffmpeg output into a single buffer.
      this.#ffmpegProc.stdout.on("data", (chunk: Buffer) => { allAudio.push(chunk); });

      this.#ffmpegProc.stderr.on("data", (chunk: Buffer) => {
        const msg = chunk.toString().trim();
        if (msg) process.stderr.write(`[MacTtsSource] ffmpeg: ${msg}\n`);
      });

      this.#ffmpegProc.on("error", (err) => {
        if (err.message.includes("ENOENT")) {
          finish(new Error("`ffmpeg` not found on PATH. Install ffmpeg to use MacTtsSource."));
        } else finish(err);
      });

      this.#ffmpegProc.on("exit", (code) => {
        if (code !== 0 && code !== null && !this.#stopped) {
          finish(new Error(`ffmpeg exited with code ${code}`));
          return;
        }

        // All audio collected — now meter it out at real-time pace.
        const fullBuffer = Buffer.concat(allAudio);
        const totalSamples = Math.floor(fullBuffer.length / FLOAT32_BYTES);
        const samplesPerChunk = 320; // 20ms @ 16kHz — matches feeder consumption rate
        const chunkIntervalMs = 20;
        let offset = 0;

        // Pre-push a small lead (~200ms) so the feeder has a head start.
        const leadChunks = 10;
        for (let i = 0; i < leadChunks && offset < totalSamples; i++) {
          const end = Math.min(offset + samplesPerChunk, totalSamples);
          const frame = fullBuffer.subarray(offset * FLOAT32_BYTES, end * FLOAT32_BYTES);
          const samples = new Float32Array(end - offset);
          for (let j = 0; j < samples.length; j++) {
            samples[j] = frame.readFloatLE(j * FLOAT32_BYTES);
          }
          if (!this.#stopped) callbacks.onChunk(samples);
          offset = end;
        }

        // Meter the rest at real-time cadence.
        this.#meterTimer = setInterval(() => {
          if (this.#stopped) { finish(); return; }
          if (offset >= totalSamples) { finish(); return; }
          const end = Math.min(offset + samplesPerChunk, totalSamples);
          const frame = fullBuffer.subarray(offset * FLOAT32_BYTES, end * FLOAT32_BYTES);
          const samples = new Float32Array(end - offset);
          for (let j = 0; j < samples.length; j++) {
            samples[j] = frame.readFloatLE(j * FLOAT32_BYTES);
          }
          if (!this.#stopped) callbacks.onChunk(samples);
          offset = end;
          if (offset >= totalSamples) finish();
        }, chunkIntervalMs);
      });
    });
  };

  /** Stop the current utterance immediately (kills ffmpeg, cleans up). */
  stop = (): void => {
    this.#stopped = true;
    if (this.#meterTimer) { clearInterval(this.#meterTimer); this.#meterTimer = null; }
    try { this.#ffmpegProc?.kill("SIGTERM"); } catch {}
    this.#ffmpegProc = null;
    this.#cleanup();
    // Resolve any pending speak() promise so callers don't hang.
    this.#finishFn?.();
  };

  /** List available voices (runs `say -v '?'`). */
  static listVoices = (): Array<{ name: string; locale: string; sample: string }> => {
    try {
      const output = execSync("say -v '?'", { encoding: "utf8" });
      return output.trim().split("\n").map((line) => {
        const match = line.match(/^(\S.+?\S)\s+(\S+)\s+#\s*(.+)$/);
        if (!match) return null;
        return { name: match[1], locale: match[2], sample: match[3] };
      }).filter(Boolean) as Array<{ name: string; locale: string; sample: string }>;
    } catch {
      return [];
    }
  };

  #cleanup = (): void => {
    if (this.#tempFile && existsSync(this.#tempFile)) {
      try { unlinkSync(this.#tempFile); } catch {}
    }
    this.#tempFile = null;
  };
}
