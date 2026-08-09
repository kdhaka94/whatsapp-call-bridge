# calling-agent

Place WhatsApp voice calls from a personal WhatsApp account (via WhatsApp Web's
VoIP WASM) and bridge the live audio to an ElevenLabs Conversational AI agent.

See `PLAN.md` for the full design and phased implementation.

## Environment

- Node >= 20 (developed on Node 25)
- ffmpeg on PATH
- macOS arm64 (tested). Should work on Linux/Windows with the right `@roamhq/wrtc` prebuilt.

## Phase 0 setup (done)

The WhatsApp Web WASM stack is vendored at `src/vendor/baileys-caller/` (MIT,
upstream https://github.com/SheIITear/baileys-caller). It is a self-contained
sub-package with its own package.json/tsconfig and the committed WASM assets at
`src/vendor/baileys-caller/assets/wasm/`.

### Build / install commands

```bash
# install vendored deps (baileys peer, @roamhq/wrtc, qrcode-terminal, tsx, typescript)
npm run vendor:install

# compile vendored TS (.mts -> dist/*.mjs) incl. worker-bootstrap.mjs
npm run vendor:build

# place a test call: <phoneNumber> [audioSource]  (audioSource defaults to media/test-tone.wav)
npm run phase0:call -- +1234567890
```

### First run / QR auth

First call prints a QR in the terminal — scan it from **WhatsApp > Settings >
Linked Devices** on your phone. The session is saved in `./auth/` (gitignored,
treat as a credential).

### Version-fix patch (applied to vendored source)

The upstream `connect()` did not pass a WhatsApp Web version to Baileys, so
WhatsApp servers rejected the connection with `405 Connection Failure` at
location `vll` (stale bundled version). The vendored `src/index.mts` was patched
to call `fetchLatestWaWebVersion()` and pass `version` to `makeWASocket`. This
patch must be preserved if re-vendoring. Symptom if it regresses: connect throws
`Error: Connection Failure` with `data: { reason: '405', location: 'vll' }`.

### QR-as-PNG patch (applied to vendored source)

The terminal QR (half-block chars) is hard to scan on low-res terminals. The
vendored `src/index.mts` QR handler was patched to also write
`<authDir>/qr.png` (480px) via the `qrcode` package and log its path. A
`src/qrcode.d.ts` ambient declaration was added so TypeScript resolves the
import. `qrcode` is installed at the project root (resolved by Node's upward
module walk).

### Phase 0 verified outcome (2026-08-09)

- Linked a personal WhatsApp account via QR (auth persisted to `./auth/`).
- Placed an outbound call to a real contact. `Ringing` fired — the callee's
  phone actually rang. **Outbound call setup is proven end-to-end.**
- Call could not complete (callee declined) because WhatsApp voice calling is
  blocked in the callee's region (UAE) without a VPN — a network restriction,
  not a library issue.
- Known gap: when the callee **rejects** the call, the vendored `ActiveCall`
  does not emit `ended`/`rejected` and the process hangs. The `remote_end`
  handler only covers WASM call-event type 2; a rejection likely arrives via a
  different signaling path. To fix in Phase 1: inspect `#handleCallEvent` and
  the signaling bridge for the reject stanza and map it to `_forceEnd("rejected")`.
- Cannot call your own linked number (WhatsApp silently won't ring self).

### Phase 1 — PushAudioFeeder + reject-path fix (2026-08-09)

**New library modules:**
- `src/whatsapp/ring-buffer.ts` — sample-level ring buffer with overflow
  (drop-oldest) and underflow stats. Unit-tested (10/10 in `test/ring-buffer.test.ts`).
- `src/whatsapp/push-audio-feeder.ts` — streaming feeder replacing the
  file-based `AudioFeeder`. Reads from a ring buffer via `push(Float32Array)`,
  meters 20ms frames to `onChunk` at real-time cadence, emits silence on
  underflow. Implements the `AudioFeederLike` interface.
- `src/whatsapp/voip-client.ts` — `WhatsAppClient` wrapper that injects the
  `PushAudioFeeder` via the vendored `feederFactory` config. Exposes
  `call.pushAudio(Float32Array)` on the returned `ActiveCall`.

**Vendored patches (src/vendor/baileys-caller/src/):**
- `types.mts`: added `AudioFeederLike` interface + `AudioFeederFactory` type +
  optional `feederFactory` on `VoipSdkConfig`.
- `index.mts`: `#handleAudioCaptureStart` uses injected factory if present;
  assigns feeder to `activeCall._feeder`; added `ActiveCall.pushAudio()` and
  `flushAudio()`; added `_wasActive` flag + reject detection in
  `_updateState` (idle/ending before active → `"rejected"`); added
  `DEBUG_CALL_EVENTS` env logging in `#handleCallEvent`.

**Build:**
- `npm run build` compiles the root library (`src/*.ts` → `dist/*.js`).
- `npm run build:all` = vendor build + root build.
- `npm run test` = vitest (ring-buffer unit tests).
- `npm run phase1:call -- <number>` = sine-tone push example (no file, no ffmpeg).

**Verified:** Placed a call with the PushAudioFeeder active. `Ringing` fired and
the feeder emitted chunks (silence during pre-connect underflow, as expected).
The streaming uplink path works. Audio-playback verification (callee hears the
tone) is blocked by the UAE calling restriction — same as Phase 0.

**Module resolution note:** `baileys-caller` is a `file:` dependency
(`node_modules/baileys-caller` → `src/vendor/baileys-caller`). The root
`tsconfig.json` has a `paths` mapping for typecheck. Do NOT use `tsx` to run
library code — tsx resolves `baileys-caller` to `.mts` source (missing exports).
Compile with `npm run build` and run examples with plain `node`.

### Phase 2 — audio codec (2026-08-09)

- `src/audio/pcm.ts` — Float32↔Int16↔base64 conversions + downmix + clamp.
  `-1.0` maps to `-32768` (min int16); clipping handled. 12 unit tests.
- `src/audio/resampler.ts` — `linearResampler` (one-shot) +
  `StreamingResampler` (stateful, carries boundary sample across chunks for
  correct interpolation at chunk edges). Used only when the ElevenLabs agent's
  TTS output format ≠ `pcm_16000`. 10 unit tests.

### Phase 3 — ElevenLabs bridge (2026-08-09)

- `src/elevenlabs/messages.ts` — typed client→server and server→client message
  definitions (initiation, `user_audio_chunk`, `audio`, `ping`/`pong`,
  `interruption`, `user_transcript`, `agent_response`, `client_error`, etc.) +
  `sampleRateForFormat()` helper.
- `src/elevenlabs/bridge.ts` — `ElevenLabsBridge` (EventEmitter): opens the WS,
  sends initiation, routes `audio` events → decode + resample to 16 kHz Float32
  (`audio` event), sends user audio as base64 `user_audio_chunk`, replies
  `pong` to `ping`, emits `interruption` (caller flushes feeder), sends
  `user_activity` every 30s, validates agentId/signedUrl in constructor.
  Injectable `webSocketFactory` for testing. 10 mocked-WS tests.

**Tests:** 42/42 passing (ring-buffer 10, pcm 12, resampler 10, bridge 10).
`npm test` runs all; `npm run build` compiles the root library cleanly.

**Setup reminder:** configure the ElevenLabs agent's TTS output format to
**PCM 16000 Hz** in the dashboard to skip resampling on the agent→call path.

### Phase 4 — AgentCaller orchestrator (2026-08-09)

The public API is complete. `AgentCaller` ties WhatsApp + ElevenLabs together:

- `src/config.ts` — `AgentCallerConfig` + `configFromEnv()` (reads
  `ELEVENLABS_AGENT_ID` / `ELEVENLABS_SIGNED_URL` / `CALLING_AGENT_AUTH_DIR`).
- `src/client.ts` — `AgentCaller` (connect/call/disconnect) + `CallSession`
  (EventEmitter: `connected`, `ringing`, `transcript`, `agentResponse`,
  `interruption`, `ended`, `error`). On `connected`, opens the ElevenLabs
  bridge; wires WhatsApp `audio` → `bridge.sendUserAudio()`, bridge `audio` →
  `call.pushAudio()`, bridge `interruption` → `call.flushAudio()`.
- `src/index.ts` — 19 public exports.
- `scripts/call-agent.mjs` — full end-to-end example: `npm run call-agent -- +91...`

**Audio flow (live):**
```
callee speaks → WhatsApp WASM → call 'audio' (16k Float32)
  → bridge.sendUserAudio() → Int16 → base64 → {user_audio_chunk} → ElevenLabs
  → agent thinks → ElevenLabs 'audio' (base64 PCM) → decode → resample to 16k
  → call.pushAudio() → PushAudioFeeder → 20ms frames → WASM uplink → callee hears agent
```

**Public API:**
```ts
import { AgentCaller, configFromEnv } from "calling-agent";
const caller = new AgentCaller(configFromEnv());
await caller.connect();                    // QR on first run
const s = await caller.call("+1234567890");
s.on("agentResponse", (t) => console.log("agent:", t));
s.on("transcript", (t) => console.log("user:", t));
s.on("ended", (r) => console.log("ended:", r));
await s.waitForEnd();
caller.disconnect();
```

**Final state:** 42/42 unit tests passing, clean build + typecheck. The only
unverified piece is a full live call (callee hears the agent and converses) —
blocked by the UAE WhatsApp calling restriction on the test callee. A live test
needs a callee in a region where WhatsApp calling works (or on a VPN).

```bash
# 1. open Chrome with remote debugging and load web.whatsapp.com (logged in)
#    open -na "Google Chrome" --args --remote-debugging-port=9222
# 2. node --experimental-websocket src/vendor/baileys-caller/scripts/fetch-wasm-resources.mjs
# 3. copy the refreshed assets from src/vendor/baileys-caller/src/lib/wasm-resources/
#    into src/vendor/baileys-caller/assets/wasm/ (note: upstream script writes to a
#    different dir than the engine reads from — the engine reads assets/wasm/)
```

## Project layout

```
src/vendor/baileys-caller/   vendored WhatsApp Web WASM call engine (Phase 1 will modify audio feeder)
scripts/phase0-call.mjs      Phase 0 test runner
media/test-tone.wav          generated 440 Hz test tone (gitignored)
auth/                        Baileys linked-device session (gitignored, credential)
PLAN.md                      full design + roadmap
```

## Notes / risks

- The WASM is reverse-engineered; a WhatsApp Web update can break it. Use
  `fetch-wasm` to refresh assets.
- Automating a personal WhatsApp account carries ToS/ban risk. Use a dedicated
  number; rate-limit calls. Personal/experimental use only.
- baileys-caller supports outbound 1:1 voice calls only (no inbound/group/video).
