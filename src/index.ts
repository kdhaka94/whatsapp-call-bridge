/**
 * calling-agent — public API.
 *
 * Place WhatsApp voice calls (via WhatsApp Web's VoIP WASM) and bridge the live
 * audio to an ElevenLabs Conversational AI agent.
 */

export { AgentCaller, CallSession, type WhatsAppClientLike, type BridgeFactory } from "./client.js";
export { WhatsAppClient } from "./whatsapp/voip-client.js";
export { PushAudioFeeder } from "./whatsapp/push-audio-feeder.js";
export { RingBuffer } from "./whatsapp/ring-buffer.js";
export { ElevenLabsBridge } from "./elevenlabs/bridge.js";
export {
  type ClientMessage,
  type ServerMessage,
  type AudioFormat,
  type ConversationInitiationClientData,
  type UserAudioChunk,
  type AudioEvent,
  type Interruption,
  type Ping,
  type Pong,
  type UserTranscript,
  type AgentResponse,
  type ConversationInitiationMetadata,
  sampleRateForFormat,
  parseServerMessage,
} from "./elevenlabs/messages.js";
export {
  float32ToInt16,
  int16ToFloat32,
  float32ToBase64,
  base64ToFloat32,
  bufferToBase64,
  base64ToBuffer,
  downmixToMono,
  clamp,
} from "./audio/pcm.js";
export { linearResampler, StreamingResampler, type Resampler } from "./audio/resampler.js";
export { MacTtsSource, type MacTtsOptions, type SpeakCallbacks } from "./audio/mac-tts.js";
export { configFromEnv, type AgentCallerConfig, type CallSessionOptions, type CallSessionEvents } from "./config.js";
