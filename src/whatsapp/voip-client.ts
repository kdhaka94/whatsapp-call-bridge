/**
 * WhatsApp VoIP client wrapper.
 *
 * Wraps the vendored baileys-caller VoipClient and injects a PushAudioFeeder
 * so that real-time audio (agent TTS) can be streamed into a live call via
 * `call.pushAudio(Float32Array)`.
 *
 * The file-based AudioFeeder path is still available: if `usePushFeeder` is
 * false, the default feeder is used and `audioSource` (file path / "silence")
 * behaves as in upstream baileys-caller.
 */
import { VoipClient, type ActiveCall as VendorActiveCall } from "../vendor/baileys-caller/dist/index.mjs";
import { PushAudioFeeder, type PushAudioFeederOptions } from "./push-audio-feeder.js";

export type WhatsAppClientOptions = {
  authDir: string;
  /** Use the streaming PushAudioFeeder (default true). Set false for file-based audio. */
  usePushFeeder?: boolean;
  /** Options passed to the PushAudioFeeder when usePushFeeder is true. */
  feederOptions?: PushAudioFeederOptions;
};

export class WhatsAppClient {
  #client: VoipClient;
  #usePushFeeder: boolean;
  #feederOptions: PushAudioFeederOptions;

  constructor(opts: WhatsAppClientOptions) {
    this.#usePushFeeder = opts.usePushFeeder ?? true;
    this.#feederOptions = opts.feederOptions ?? {};
    this.#client = new VoipClient(
      this.#usePushFeeder
        ? {
            authDir: opts.authDir,
            feederFactory: ({ sampleRate, channels, framesPerChunk, onChunk }) =>
              new PushAudioFeeder(sampleRate, channels, framesPerChunk, onChunk, this.#feederOptions),
          }
        : { authDir: opts.authDir },
    );
  }

  connect = (): Promise<void> => this.#client.connect();

  call = async (
    phoneNumber: string,
    opts: { audioSource?: string; durationMs?: number } = {},
  ): Promise<VendorActiveCall> => this.#client.call(phoneNumber, opts);

  disconnect = (): void => this.#client.disconnect();
}

export type { VendorActiveCall as ActiveCall };
