/**
 * Speech-to-text provider interface.
 *
 * All STT providers implement this interface so they're interchangeable.
 * The caller pipes `Float32Array` PCM (16 kHz mono, from a WhatsApp call's
 * `audio` event) via `feedAudio()`, and receives partial/final transcripts
 * via callbacks.
 *
 * Usage:
 *   const stt = new AssemblyAIStt({ apiKey: "..." });
 *   await stt.start({
 *     onPartial: (text) => console.log("partial:", text),
 *     onFinal: (text) => console.log("final:", text),
 *   });
 *   call.on("audio", (pcm) => stt.feedAudio(pcm));
 *   // later:
 *   await stt.stop();
 */

export type SttCallbacks = {
  /** Partial (interim) transcript — updated as the person speaks. */
  onPartial?: (text: string) => void;
  /** Final transcript — when the speaker pauses / a segment is complete. */
  onFinal?: (text: string) => void;
  /** Fatal error. */
  onError?: (err: Error) => void;
};

export interface SttProvider {
  /** Start the STT session. Resolves when ready to receive audio. */
  start: (callbacks: SttCallbacks) => Promise<void>;
  /** Feed 16 kHz mono Float32 PCM audio in. Called on each call `audio` event. */
  feedAudio: (pcm: Float32Array) => void;
  /** Stop the STT session and flush any pending results. */
  stop: () => Promise<void>;
}
