/**
 * ElevenLabs Conversational AI WebSocket message types.
 *
 * Endpoint: wss://api.elevenlabs.io/v1/convai/conversation?agent_id=<id>
 * (public agent), or with a signed URL for private agents.
 *
 * Audio format note: the `conversation_initiation_metadata` event reports
 * `user_input_audio_format` (what we send) and `agent_output_audio_format`
 * (what we receive). Both are `pcm_16000` (16-bit signed LE, mono, 16 kHz) when
 * the agent is configured with "TTS output format → PCM 16000 Hz".
 */

// ─── Audio formats (from conversation_initiation_metadata) ──────────────────
export type AudioFormat =
  | "pcm_8000"
  | "pcm_16000"
  | "pcm_22050"
  | "pcm_24000"
  | "pcm_44100"
  | "pcm_48000"
  | "ulaw_8000";

export const sampleRateForFormat = (fmt: AudioFormat): number => {
  switch (fmt) {
    case "pcm_8000": case "ulaw_8000": return 8000;
    case "pcm_16000": return 16000;
    case "pcm_22050": return 22050;
    case "pcm_24000": return 24000;
    case "pcm_44100": return 44100;
    case "pcm_48000": return 48000;
  }
};

// ─── Client → Server messages ────────────────────────────────────────────────

/** Sent immediately after WS open to initiate the conversation. */
export interface ConversationInitiationClientData {
  type: "conversation_initiation_client_data";
  conversation_config_override?: Record<string, unknown>;
  custom_llm_extra_body?: Record<string, unknown>;
  user_id?: string;
  source_info?: { source?: string; variant?: string };
  branch_id?: string;
  environment?: string;
  starting_workflow_node_id?: string;
  dynamic_variables?: Record<string, string>;
}

/** Base64-encoded user audio. No `type` field — detected by `user_audio_chunk` key. */
export interface UserAudioChunk {
  user_audio_chunk: string;
}

/** Keepalive response to a server `ping`. */
export interface Pong {
  type: "pong";
  event_id: number;
  stream_id?: number;
}

/** Text injected as if the user spoke it. */
export interface UserMessage {
  type: "user_message";
  text: string;
}

/** Non-interrupting background context update. */
export interface ContextualUpdate {
  type: "contextual_update";
  text: string;
}

/** Activity ping to reset the turn timeout (every ~30s). */
export interface UserActivity {
  type: "user_activity";
}

export type ClientMessage =
  | ConversationInitiationClientData
  | UserAudioChunk
  | Pong
  | UserMessage
  | ContextualUpdate
  | UserActivity;

// ─── Server → Client messages ────────────────────────────────────────────────

export interface ConversationInitiationMetadataEvent {
  conversation_id: string;
  agent_output_audio_format: AudioFormat;
  user_input_audio_format: AudioFormat;
}

export interface ConversationInitiationMetadata {
  type: "conversation_initiation_metadata";
  conversation_initiation_metadata_event: ConversationInitiationMetadataEvent;
}

export interface AudioEvent {
  type: "audio";
  audio_event: {
    audio_base_64: string;
    event_id: number;
    alignment?: {
      chars: string[];
      char_durations_ms: number[];
      char_start_times_ms: number[];
    };
  };
}

export interface UserTranscript {
  type: "user_transcript";
  user_transcript_event: { transcript: string; transcript_id: number };
}

export interface TentativeUserTranscript {
  type: "tentative_user_transcript";
  tentative_user_transcript_event: { transcript: string; is_final: boolean };
}

export interface AgentResponse {
  type: "agent_response";
  agent_response_event: { response: string; response_id: number };
}

export interface AgentResponseCorrection {
  type: "agent_response_correction";
  agent_response_correction_event: {
    original_response: string;
    corrected_response: string;
    response_id: number;
  };
}

export interface Interruption {
  type: "interruption";
  interruption_event: { event_id: number };
}

export interface Ping {
  type: "ping";
  ping_event?: { event_id: number; stream_id?: number };
  event_id?: number;
}

export interface ClientError {
  type: "client_error";
  error_event: { code: number; error_name: string; message?: string };
}

export type ServerMessage =
  | ConversationInitiationMetadata
  | AudioEvent
  | UserTranscript
  | TentativeUserTranscript
  | AgentResponse
  | AgentResponseCorrection
  | Interruption
  | Ping
  | ClientError;

/** Narrow an unknown parsed message to a typed ServerMessage (best-effort). */
export const parseServerMessage = (raw: unknown): ServerMessage => {
  if (typeof raw !== "object" || raw === null) throw new Error("invalid server message");
  return raw as ServerMessage;
};
