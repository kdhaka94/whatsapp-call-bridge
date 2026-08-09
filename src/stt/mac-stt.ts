/**
 * macOS built-in STT provider using Apple's SFSpeechRecognizer.
 *
 * Uses a bundled Swift helper that reads PCM audio from stdin (16-bit signed,
 * 16 kHz, mono) and outputs JSON transcripts on stdout. The helper is
 * auto-compiled on first use using `swiftc`.
 *
 * Works offline (on-device recognition) for supported locales. No API key.
 * macOS 10.15+ required. Siri/Dictation must be enabled in System Settings.
 *
 * The Swift helper does streaming recognition — it processes audio as it
 * arrives and emits partial + final transcripts incrementally.
 */
import { spawn, execSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SttProvider, SttCallbacks } from "./types.js";
import { float32ToInt16 } from "../audio/pcm.js";

export type MacSttOptions = {
  /** Locale identifier (e.g. "en-US", "es-ES", "fr-FR"). Default: "en-US" */
  locale?: string;
  /** Require on-device recognition (no Apple servers). Default: true */
  onDeviceOnly?: boolean;
  /** Path to a pre-compiled helper binary. If omitted, auto-compiles. */
  helperPath?: string;
};

/** The Swift helper source code. */
const SWIFT_SOURCE = `
import Speech
import Foundation

// Read configuration from args/env
let locale = Locale(identifier: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "en-US")
let onDeviceOnly = ProcessInfo.processInfo.environment["TRANSCRIBE_ON_DEVICE_ONLY"] == "1"

guard let recognizer = SFSpeechRecognizer(locale: locale) else {
    fputs("{\\"error\\": \\"SFSpeechRecognizer not available for locale \\(locale.identifier)\\"}\\n", stderr)
    exit(1)
}
if !recognizer.isAvailable {
    fputs("{\\"error\\": \\"Speech recognizer not available (enable Dictation in System Settings)\\"}\\n", stderr)
    exit(1)
}

let request = SFSpeechAudioBufferRecognitionRequest()
request.shouldReportPartialResults = true
if onDeviceOnly { request.requiresOnDeviceRecognition = true }

var task: SFSpeechRecognitionTask?
let sema = DispatchSemaphore(value: 0)
var lastText = ""

func startRecognition() {
    task = recognizer.recognitionTask(with: request) { result, error in
        if let result = result {
            let text = result.bestTranscription.formattedString
            let isFinal = result.isFinal
            let payload: [String: Any] = ["text": text, "is_final": isFinal]
            if let json = try? JSONSerialization.data(withJSONObject: payload),
               let str = String(data: json, encoding: .utf8) {
                print(str)
                fflush(stdout)
            }
            lastText = text
        }
        if let error = error {
            let payload: [String: Any] = ["error": error.localizedDescription]
            if let json = try? JSONSerialization.data(withJSONObject: payload),
               let str = String(data: json, encoding: .utf8) {
                fputs(str + "\\n", stderr)
            }
            sema.signal()
        }
        if result?.isFinal == true { sema.signal() }
    }
}

startRecognition()

// Read PCM from stdin in a background thread
let queue = DispatchQueue(label: "audio-input")
queue.async {
    let bufSize = 3200 // 200ms @ 16kHz 16-bit mono
    while true {
        var data = Data()
        let chunk = FileHandle.standardInput.availableData
        if chunk.isEmpty { break }
        data.append(chunk)
        if data.count >= 2 {
            let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: false)!
            if let pcmBuf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(data.count / 2)) {
                pcmBuf.frameLength = AVAudioFrameCount(data.count / 2)
                data.withUnsafeBytes { ptr in
                    pcmBuf.int16ChannelData?[0].update(from: ptr.bindMemory(to: Int16.self).baseAddress!, count: data.count / 2)
                }
                request.append(pcmBuf)
            }
        }
    }
    request.endAudio()
}

sema.wait()
`;

export class MacStt implements SttProvider {
  #opts: MacSttOptions;
  #proc: ChildProcessWithoutNullStreams | null = null;
  #callbacks: SttCallbacks | null = null;
  #stopped = false;
  #helperCompiled = false;

  constructor(opts: MacSttOptions = {}) {
    this.#opts = opts;
  }

  start = async (callbacks: SttCallbacks): Promise<void> => {
    this.#callbacks = callbacks;
    this.#stopped = false;

    const helperPath = this.#opts.helperPath ?? await this.#ensureHelper();
    const locale = this.#opts.locale ?? "en-US";
    const env = { ...process.env, TRANSCRIBE_ON_DEVICE_ONLY: String(this.#opts.onDeviceOnly ?? true) };

    this.#proc = spawn(helperPath, [locale], { env });

    this.#proc.stdout.on("data", (chunk: Buffer) => {
      try {
        const lines = chunk.toString().trim().split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.error) { this.#callbacks?.onError?.(new Error(msg.error)); }
          else if (msg.text) {
            if (msg.is_final) this.#callbacks?.onFinal?.(msg.text);
            else this.#callbacks?.onPartial?.(msg.text);
          }
        }
      } catch { /* partial/bad JSON — ignore */ }
    });

    this.#proc.stderr.on("data", (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) process.stderr.write(`[MacStt] ${msg}\n`);
    });

    this.#proc.on("error", (err) => {
      if (err.message.includes("ENOENT")) {
        this.#callbacks?.onError?.(new Error("Swift helper not found. Ensure Swift is installed (Xcode Command Line Tools)."));
      } else this.#callbacks?.onError?.(err);
    });

    this.#proc.on("exit", (code) => {
      if (!this.#stopped && code !== 0 && code !== null) {
        this.#callbacks?.onError?.(new Error(`Swift helper exited with code ${code}`));
      }
    });
  };

  feedAudio = (pcm: Float32Array): void => {
    if (!this.#proc || this.#stopped) return;
    const int16 = float32ToInt16(pcm);
    try { this.#proc.stdin.write(int16); } catch {}
  };

  stop = async (): Promise<void> => {
    this.#stopped = true;
    try { this.#proc?.stdin.end(); } catch {}
    try { this.#proc?.kill("SIGTERM"); } catch {}
    this.#proc = null;
  };

  /** Compile the Swift helper on first use. Returns the binary path. */
  #ensureHelper = async (): Promise<string> => {
    const cacheDir = join(tmpdir(), "calling-agent-swift-helpers");
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
    const binPath = join(cacheDir, "mac-stt-helper");

    if (existsSync(binPath)) return binPath;

    const srcPath = join(cacheDir, "mac-stt-helper.swift");
    writeFileSync(srcPath, SWIFT_SOURCE);

    return new Promise<string>((resolve, reject) => {
      try {
        execSync(`swiftc -O -o "${binPath}" "${srcPath}" -framework Speech -framework AVFoundation 2>&1`, {
          encoding: "utf8",
          timeout: 60_000,
        });
        this.#helperCompiled = true;
        // Clean up source after successful compile.
        try { unlinkSync(srcPath); } catch {}
        resolve(binPath);
      } catch (err: any) {
        reject(new Error(`Failed to compile Swift helper: ${err.message}. Ensure Xcode Command Line Tools are installed (xcode-select --install).`));
      }
    });
  };
}
