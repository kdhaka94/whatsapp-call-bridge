/**
 * Configuration types + env loading for calling-agent.
 */
import { type Resampler } from "./audio/resampler.js";

export type AgentCallerConfig = {
  /** Path to the Baileys multi-file auth state directory (WhatsApp session). */
  authDir: string;
  /** ElevenLabs agent configuration. */
  elevenlabs: {
    /** Agent ID (for public agents) OR provide signedUrl for private agents. */
    agentId?: string;
    /** Signed URL for private agents (takes precedence over agentId). */
    signedUrl?: string;
    /** ElevenLabs API key (only needed to fetch a signed URL for private agents). */
    apiKey?: string;
    /** Optional initiation data: dynamic variables, config override, etc. */
    initiationData?: Record<string, unknown>;
  };
  /** Custom resampler for agent→call audio (default: linear). Rarely needed. */
  resampler?: Resampler;
  /** Feeder buffer depth in seconds (default 2). Larger = more jitter tolerance. */
  feederBufferSeconds?: number;
  /** Enable feeder debug stats logging. Default false. */
  feederDebug?: boolean;
};

/** Load config from environment variables with a fallback object. */
export const configFromEnv = (overrides: Partial<AgentCallerConfig> = {}): AgentCallerConfig => {
  const authDir = overrides.authDir ?? process.env.CALLING_AGENT_AUTH_DIR ?? "./auth";
  const agentId = overrides.elevenlabs?.agentId ?? process.env.ELEVENLABS_AGENT_ID;
  const signedUrl = overrides.elevenlabs?.signedUrl ?? process.env.ELEVENLABS_SIGNED_URL;
  const apiKey = overrides.elevenlabs?.apiKey ?? process.env.ELEVENLABS_API_KEY;

  if (!agentId && !signedUrl) {
    throw new Error(
      "ElevenLabs agentId or signedUrl is required. Set ELEVENLABS_AGENT_ID or pass it in config.",
    );
  }

  return {
    authDir,
    elevenlabs: { agentId, signedUrl, apiKey, ...(overrides.elevenlabs?.initiationData ? { initiationData: overrides.elevenlabs.initiationData } : {}) },
    ...(overrides.resampler ? { resampler: overrides.resampler } : {}),
    ...(overrides.feederBufferSeconds ? { feederBufferSeconds: overrides.feederBufferSeconds } : {}),
    ...(overrides.feederDebug ? { feederDebug: overrides.feederDebug } : {}),
  };
};

export type CallSessionOptions = {
  /** Dynamic variables for this conversation (e.g. { customer_name: "Daniele" }). */
  dynamicVariables?: Record<string, string>;
  /** Auto-hangup safety after N ms. Default 120000 (2 min). */
  durationMs?: number;
};

export type CallSessionEvents = {
  /** WhatsApp call connected and ElevenLabs agent session is live. */
  connected: () => void;
  /** WhatsApp call is ringing on the callee's phone. */
  ringing: () => void;
  /** Finalized user utterance transcript (from ElevenLabs ASR). */
  transcript: (text: string) => void;
  /** Tentative (partial) user transcript. */
  tentativeTranscript: (text: string, isFinal: boolean) => void;
  /** Complete agent text response. */
  agentResponse: (text: string) => void;
  /** Corrected agent text response. */
  agentResponseCorrection: (original: string, corrected: string) => void;
  /** User interrupted the agent (agent stops speaking). */
  interruption: () => void;
  /** Call ended. Reason: hangup | timeout | rejected | remote_end | disconnect | error. */
  ended: (reason: string) => void;
  /** Fatal error. */
  error: (err: Error) => void;
};
