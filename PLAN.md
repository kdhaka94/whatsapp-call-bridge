# WhatsApp Web Calling + ElevenLabs Voice Agent Library

A Node.js/TypeScript library that places **outbound WhatsApp voice calls from a personal WhatsApp account** (via WhatsApp Web's VoIP WASM) and bridges the live call audio bidirectionally to an **ElevenLabs Conversational AI agent**, so a contact receives a normal WhatsApp call and has a real-time voice conversation with the AI.

## Decisions (confirmed)

- **Call path:** WhatsApp Web WASM (unofficial, personal account, via `baileys-caller`). NOT the official ElevenLabs WhatsApp Business API.
- **Direction:** Outbound only (inbound/group/video are unsupported by the WASM backend).
- **Runtime:** TypeScript / Node.js (env has Node v25.8.0, ffmpeg, Chrome).

## Architecture

```
            ElevenLabs Conv AI                  WhatsApp Web VoIP
            (wss://api.elevenlabs.io            (Baileys signaling +
             /v1/convai/conversation)            WhatsApp Web WASM stack)

  user audio  ┌───────────────┐  agent audio (TTS)
  (pcm_16000) │  ElevenLabs   │  (base64 PCM, agent_output_audio_format)
   base64  ──▶│    Bridge     │──▶  decode + resample to 16k Float32
             │  (WS client)  │                          │
             └──────┬────────┘                          ▼
                    │                          ┌───────────────────┐
   user audio       │                          │  PushAudioFeeder  │  20ms Float32
   Float32 16k ◀────│ caller.audio event       │  (jitter buffer + │── frames ──▶
                    │ (16k mono Float32)       │   metering)       │  engine.sendAudioData
                    │                          └───────────────────┘
                    ▼                                    ▲
            Float32→Int16→base64                   ActiveCall.pushAudio
            → { user_audio_chunk }                 + Writable audioSink
```

The orchestrator (`AgentCaller`) owns: a `VoipClient` (WhatsApp) and, per call, an `ElevenLabsBridge` (agent WS) + a `PushAudioFeeder` (replaces baileys-caller's file-only feeder).

### End-to-end flow

1. `AgentCaller.connect()` → Baileys QR scan (first run) + WASM VoIP stack init.
2. `AgentCaller.call(phone)` → `VoipClient.call()`; `ActiveCall` emits `ringing` then `connected`.
3. On `connected`: open ElevenLabs WS, send `conversation_initiation_client_data`. Wait for `conversation_initiation_metadata` (gives `agent_output_audio_format` + `user_input_audio_format`).
4. **User → Agent:** `ActiveCall` `audio` event (16 kHz mono `Float32Array`) → convert to Int16 LE → base64 → send `{ user_audio_chunk: <b64> }`.
5. **Agent → User:** `audio` event `audio_base_64` → decode to Int16 PCM at output rate → resample to 16 kHz → `Float32Array` → `call.pushAudio(float32)`. The `PushAudioFeeder` meters 20 ms frames to `engine.sendAudioData()`.
6. `ping` → `{ type:"pong", event_id }` keepalive. `interruption` → flush feeder queue (stop agent mid-word).
7. Either side ends → tear down WS + feeder; `ended` event.

## The core technical problem & solution

**Problem:** `baileys-caller`'s `AudioFeeder` (src/audio-feeder.mts) only accepts a **file path** (MP3/WAV) or `"silence"` — it spawns ffmpeg and meters fixed frames. There is **no way to stream dynamically-generated audio** (agent TTS) into a live call. Its injection point is `engine.sendAudioData(Float32Array chunk, capturePtr)`, called every 20 ms (320 frames @ 16 kHz).

**Solution:** Vendor `baileys-caller` and replace `AudioFeeder` with a new `PushAudioFeeder`:
- Same cadence contract: emit `Float32Array` chunks of `framesPerChunk * channels` samples at `(framesPerChunk/sampleRate)*1000` ms intervals to `onChunk`.
- Reads from an internal **ring buffer** instead of ffmpeg stdout.
- `push(Float32Array)`: appends samples (downmixed/normalized to mono 16k if needed).
- **Underflow** → emit a zero-filled chunk (silence) so the WhatsApp uplink never stalls; track `underflowChunks`.
- **Overflow** (queue full) → drop oldest (prioritize low latency / interruption responsiveness over completeness); track `droppedChunks`.
- Backpressure signal exposed for observability.
- Public surface on `ActiveCall`: `pushAudio(Float32Array)` + a Node `Writable` stream `audioSink` (object mode, Float32Array).

## Audio format bridge (exact, pure JS — no deps)

ElevenLabs formats (from `conversation_initiation_metadata`): `pcm_16000` (16-bit signed LE, mono, 16 kHz) is the target for both directions. The agent's TTS output format is set in the ElevenLabs dashboard ("TTS output format → PCM 16000 Hz"); if it differs, we resample.

- **Float32 → Int16:** `clamp(s,-1,1) * 32767 | 0`, write `Int16LE`. (`Buffer` write.)
- **Int16 → Float32:** `Int16LE / 32768`.
- **base64:** `Buffer.from(int16Buf).toString("base64")` and reverse.
- **Resample (fallback, e.g. 44100→16000):** linear interpolation by default; pluggable for a sinc/LPF implementation. Document that setting the agent output to 16 kHz avoids this entirely.
- Channels: WhatsApp is mono; ElevenLabs PCM is mono. If any source is stereo, downmix `(l+r)/2`.

## ElevenLabs WebSocket protocol (client → server)

- Endpoint: `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=<id>` (public agent), or with a signed URL for private agents (server fetches signed URL using API key; key never client-side).
- On open: `{ type:"conversation_initiation_client_data", dynamic_variables?, conversation_config_override?, user_id?, branch_id?, environment? }`.
- Audio in: `{ user_audio_chunk: "<base64>" }` (no `type` field — detected by key presence).
- Keepalive: on `{ type:"ping", ... }` reply `{ type:"pong", event_id }` promptly.
- Optional: `{ type:"user_activity" }` every ~30 s; `{ type:"contextual_update", text }`; `{ type:"user_message", text }`.

## ElevenLabs WebSocket protocol (server → client)

- `conversation_initiation_metadata` → capture formats + `conversation_id`.
- `audio` → `{ audio_event: { audio_base_64, event_id, alignment } }` → agent TTS chunk (decode + push).
- `interruption` → flush `PushAudioFeeder` queue.
- `user_transcript` / `tentative_user_transcript` → emit for logging/UI.
- `agent_response` / `agent_response_correction` → emit text.
- `ping` → pong. `client_error` → surface + teardown. `vad_score` / `interruption` → observability.

## Module / file structure

```
calling-agent/
  package.json                 # type: module; deps: @whiskeysockets/baileys (peer),
                               #   @roamhq/wrtc, qrcode-terminal, ws; dev: tsx, typescript, vitest
  tsconfig.json
  README.md                    # setup, QR auth, agent config (16k), risks
  src/
    index.ts                   # public exports
    client.ts                  # AgentCaller — orchestrator (connect/call/end)
    config.ts                  # config types + env loading
    whatsapp/
      voip-client.ts           # thin wrapper over vendored baileys-caller VoipClient
      push-audio-feeder.ts     # NEW streaming feeder (replaces AudioFeeder)
      active-call.ts           # ActiveCall + pushAudio + audioSink Writable
      ring-buffer.ts           # sample-level ring buffer w/ overflow/underflow stats
    elevenlabs/
      bridge.ts                # ElevenLabsBridge — WS lifecycle + event emitter
      messages.ts              # typed client/server message definitions
    audio/
      pcm.ts                   # float32<->int16<->base64, downmix
      resampler.ts             # linear resampler (pluggable)
    vendor/
      baileys-caller/          # vendored MIT source, modified to use PushAudioFeeder
        src/ ...               # (wasm-engine, signaling, relay-transport kept as-is)
        assets/wasm/           # whatsapp.wasm, loader.js, worker-modules.js
  examples/
    call-agent.ts              # CLI: AgentCaller.call(number) -> talk to agent
  scripts/
    fetch-wasm.mjs             # refresh WASM assets from a live WhatsApp Web session
  test/
    pcm.test.ts                # conversion round-trips, clipping, base64
    resampler.test.ts          # 44.1k->16k correctness vs reference
    ring-buffer.test.ts        # overflow drop-oldest, underflow silence, ordering
    bridge.test.ts             # mocked WS: initiation, ping/pong, audio routing, interruption flush
```

## Public API (sketch)

```ts
import { AgentCaller } from "calling-agent";

const caller = new AgentCaller({
  authDir: "./auth",
  elevenlabs: {
    agentId: process.env.ELEVENLABS_AGENT_ID!,
    apiKey: process.env.ELEVENLABS_API_KEY,           // for private agents / signed URL
    // signedUrlProvider?: (agentId) => Promise<string>  // alt to apiKey
  },
});

await caller.connect();                       // QR on first run (WhatsApp > Linked Devices)

const session = await caller.call("+1234567890", {
  dynamicVariables: { customer_name: "Daniele" },
  durationMs: 120_000,                         // auto-hangup safety
});

session.on("connected",    () => console.log("call connected, agent live"));
session.on("transcript",   (e) => console.log(`user: ${e.text}`));
session.on("agentResponse",(t) => console.log(`agent: ${t}`));
session.on("interruption", () => console.log("user interrupted"));
session.on("ended",        (r) => console.log("ended:", r));

// later
await session.end();
await caller.disconnect();
```

## Dependencies

- `@whiskeysockets/baileys` ^7.0.0-rc11 (peer) — WhatsApp WebSocket protocol/auth/signaling.
- `@roamhq/wrtc` ^0.10.0 — WebRTC for the WASM relay transport (vendored dep).
- `qrcode-terminal` — QR for first-run auth.
- `ws` — ElevenLabs WebSocket client (Node native `WebSocket` also fine on v25).
- **ffmpeg on PATH** — only required for the legacy file-based `audioSource` fallback; the agent (push) path is pure JS.
- Node >= 20 (env has v25.8.0). macOS/Linux/Windows.
- Vendored: `baileys-caller` (MIT) under `src/vendor/`.

## Phased implementation

- **Phase 0 — Scaffold & prove WASM.** Init package/tsconfig; vendor baileys-caller; `npm run fetch-wasm`; run the unmodified example: place a call to a test number, play a file, confirm callee hears it and we receive `audio` frames. *Exit gate: a real WhatsApp call plays a file.*
- **Phase 1 — PushAudioFeeder.** Implement `ring-buffer.ts` + `push-audio-feeder.ts`; wire into vendored `VoipClient` (`#handleAudioCaptureStart` uses `PushAudioFeeder`); add `ActiveCall.pushAudio()` + `audioSink`. *Test: push a generated 440 Hz sine Float32 stream; callee hears a tone (no file, no ffmpeg).*
- **Phase 2 — Audio codec.** `pcm.ts` + `resampler.ts` with unit tests (round-trips, clipping, 44.1k→16k vs reference).
- **Phase 3 — ElevenLabsBridge.** WS connect, initiation, ping/pong, `audio` → decode/resample → callback, `user_audio_chunk` send, `interruption` → flush callback, typed events. *Test: mocked WS server asserts message sequence + audio routing.*
- **Phase 4 — AgentCaller orchestrator.** `connect`/`call`/`end` lifecycle; on `connected` start bridge; wire `call.audio` → bridge input; wire bridge `audioOut` → `call.pushAudio`; wire `interruption` → feeder flush; teardown on `ended`/`error`/`disconnect`.
- **Phase 5 — CLI example, README, env config, error handling, reconnect, graceful shutdown (SIGINT).**
- **Phase 6 (optional)** — transcript logging, `conversation_config_override`, agent branch/environment, per-call dynamic variables, call-duration policies, metrics (dropped/underflow chunks, latency).

## Risks & mitigations

- **WhatsApp WASM breaks on updates** → pin a known-good version; `scripts/fetch-wasm.mjs` to re-extract from a live WhatsApp Web session; document refresh procedure; CI smoke test.
- **ToS / ban risk** (automating a personal WhatsApp account) → document clearly as personal/experimental; recommend a dedicated secondary number; rate-limit calls; this is the user's accepted tradeoff for the WASM path.
- **baileys-caller is 1 commit / 44 stars / unmaintained** → vendor and own it; pin Baileys version; isolate modifications to the feeder wiring.
- **Latency** (WS TTS → resample → 20 ms metering) → expect ~200–400 ms added; tune feeder warmup (currently 500 ms) and buffer depth; prefer 16 kHz agent output to skip resampling.
- **Output format mismatch** → resampler fallback; README instructs setting agent TTS output to PCM 16000 Hz.
- **No inbound/group/video** → out of scope by decision; document.

## Testing

- **Unit:** `pcm` conversions (round-trip, clipping, base64), `resampler` (44.1k→16k vs reference), `ring-buffer` (overflow drop-oldest, underflow silence, FIFO order).
- **Bridge integration:** mocked ElevenLabs WS server (via `ws`) asserting: initiation message shape, ping→pong, `audio` event routes decoded PCM to output callback, `user_audio_chunk` base64 sent on input, `interruption` invokes flush.
- **End-to-end (manual, requires auth + real callee + agent):** via `examples/call-agent.ts` — call rings, callee answers, hears agent's first message, callee speaks, agent responds, interruption stops agent, hangup cleans up. Document the manual checklist (can't be automated without a real phone).

## Out of scope

- Inbound calls, group calls, video (WASM backend doesn't support them).
- The official ElevenLabs WhatsApp Business API path (could be a future pluggable backend).
- Python bindings (Node-only by the WASM requirement).
- Multi-call concurrency (baileys-caller allows one active call at a time; can be lifted later with multiple VoipClient instances).
