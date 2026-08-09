# calling-agent

Place **outbound WhatsApp voice calls** from a personal WhatsApp account and bridge the live audio to any voice source — an **ElevenLabs Conversational AI agent**, **macOS TTS**, a **microphone**, an **audio file**, or any real-time audio stream.

Built on [baileys-caller](https://github.com/SheIITear/baileys-caller) (WhatsApp Web's VoIP WASM stack + Baileys), with a custom streaming audio feeder that lets you push real-time audio into a live call and receive the callee's voice as PCM.

```
your audio source ──▶ call.pushAudio(Float32) ──▶ WhatsApp uplink ──▶ callee hears it
callee speaks ──▶ WhatsApp downlink ──▶ call 'audio' event (16k Float32) ──▶ your handler
```

## Features

- **Outbound WhatsApp voice calls** from a personal account (via WhatsApp Web WASM)
- **Real-time audio streaming** in both directions — push any `Float32Array` in, receive PCM out
- **ElevenLabs Conversational AI** integration (WebSocket bridge with ping/pong, interruption flush)
- **macOS TTS** source (`say` command — 100+ voices, no cloud required)
- **Source-agnostic** — use any audio source: microphone, file, TTS, RTP, WebSocket stream
- **16 kHz mono Float32** PCM throughout (matches WhatsApp Web's native format)
- TypeScript, 57 unit + integration tests, clean build

## Requirements

- **Node.js** >= 20
- **ffmpeg** on PATH
- **macOS** for `MacTtsSource` (the core library works on Linux/Windows too)
- A **WhatsApp account** to link as a device (scan a QR on first run)

## Install

```bash
git clone <repo-url> calling-agent
cd calling-agent

# install + build the vendored WhatsApp WASM stack and the root library
npm run vendor:install
npm run build:all
```

## Quick start

### 1. ElevenLabs agent on a WhatsApp call

```ts
import { AgentCaller, configFromEnv } from "calling-agent";

const caller = new AgentCaller(configFromEnv());  // reads ELEVENLABS_AGENT_ID
await caller.connect();                            // QR on first run → scan in WhatsApp > Linked Devices

const session = await caller.call("+1234567890");
session.on("connected",    () => console.log("agent is live on the call"));
session.on("transcript",   (text) => console.log("user:", text));
session.on("agentResponse",(text) => console.log("agent:", text));
session.on("ended",        (reason) => console.log("ended:", reason));

await session.waitForEnd();
caller.disconnect();
```

```bash
ELEVENLABS_AGENT_ID=your-agent-id npm run call-agent -- +1234567890
```

> **Tip:** Set your ElevenLabs agent's **TTS output format to PCM 16000 Hz** in the dashboard (Agent → Voice) to skip resampling.

### 2. macOS TTS on a WhatsApp call (no cloud)

```ts
import { WhatsAppClient, MacTtsSource } from "calling-agent";

const client = new WhatsAppClient({ authDir: "./auth" });
await client.connect();
const call = await client.call("+1234567890", { audioSource: "silence" });

const tts = new MacTtsSource();
call.on("connected", async () => {
  await tts.speak("Hello, how are you?", { voice: "Samantha", rate: 200 }, {
    onChunk: (pcm) => call.pushAudio(pcm),
  });
});

// receive the callee's voice:
call.on("audio", (pcm) => { /* 16k mono Float32Array */ });

call.on("ended", (reason) => { client.disconnect(); });
await call.waitForEnd();
```

```bash
TTS_VOICE=Samantha npm run mac-tts:call -- +1234567890 "Hello there!"
```

### 3. Raw streaming (any audio source)

```ts
import { WhatsAppClient } from "calling-agent";

const client = new WhatsAppClient({ authDir: "./auth" });
await client.connect();
const call = await client.call("+1234567890", { audioSource: "silence" });

// OUT: push any 16 kHz mono Float32Array — file, mic, TTS, RTP, generated, etc.
call.on("connected", () => {
  // e.g. read from an audio file with ffmpeg, or capture from a mic
  myAudioSource.onData((pcm: Float32Array) => call.pushAudio(pcm));
});

// IN: callee's voice as 16 kHz mono Float32Array
call.on("audio", (pcm: Float32Array) => {
  // save to file, transcribe, forward, analyze, etc.
});

call.on("ringing", () => console.log("ringing"));
call.on("ended", (reason) => client.disconnect());
```

## API

### `WhatsAppClient` — raw call + streaming

```ts
new WhatsAppClient({ authDir: string, feederOptions?: PushAudioFeederOptions })
```

| Method | Returns | Description |
|--------|---------|-------------|
| `connect()` | `Promise<void>` | Connect to WhatsApp (QR on first run) |
| `call(phone, opts?)` | `Promise<ActiveCall>` | Place an outbound call |
| `disconnect()` | `void` | Close the WhatsApp socket |

**`ActiveCall`** (returned by `call()`):

| Method / Event | Description |
|----------------|-------------|
| `pushAudio(Float32Array)` | Stream audio into the call (callee hears it) |
| `flushAudio()` | Flush buffered audio (e.g. on interruption) |
| `mute(bool)` | Mute/unmute the uplink |
| `end()` | Hang up |
| `waitForEnd()` | `Promise<string>` — resolves with end reason |
| `on("ringing")` | Callee's phone is ringing |
| `on("connected")` | Call answered, media flowing |
| `on("audio", Float32Array)` | Callee's voice (16 kHz mono PCM) |
| `on("ended", reason)` | Call ended (`hangup` / `rejected` / `remote_end` / `timeout`) |

### `AgentCaller` — ElevenLabs integration

```ts
new AgentCaller({ authDir, elevenlabs: { agentId } })
```

| Method | Returns | Description |
|--------|---------|-------------|
| `connect()` | `Promise<void>` | Connect to WhatsApp |
| `call(phone, opts?)` | `Promise<CallSession>` | Place a call + open ElevenLabs agent |
| `disconnect()` | `void` | Disconnect |

**`CallSession`** events: `connected`, `ringing`, `transcript`, `tentativeTranscript`, `agentResponse`, `agentResponseCorrection`, `interruption`, `ended`, `error`.

### `MacTtsSource` — macOS TTS

```ts
const tts = new MacTtsSource();
await tts.speak("text", { voice: "Samantha", rate: 200 }, {
  onChunk: (pcm: Float32Array) => call.pushAudio(pcm),
  onEnd: () => {},
  onError: (err) => {},
});
tts.stop();                          // interrupt mid-utterance
MacTtsSource.listVoices();           // → [{ name, locale, sample }, ...]
```

### Audio utilities

```ts
import { float32ToInt16, int16ToFloat32, float32ToBase64, base64ToFloat32, downmixToMono, linearResampler, StreamingResampler } from "calling-agent";
```

## Configuration

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ELEVENLABS_AGENT_ID` | For AgentCaller | ElevenLabs agent ID (public agent) |
| `ELEVENLABS_SIGNED_URL` | Alt to agentId | Signed URL for private agents |
| `ELEVENLABS_API_KEY` | For private agents | Used to fetch signed URLs |
| `CALLING_AGENT_AUTH_DIR` | No (default `./auth`) | WhatsApp session directory |
| `TTS_VOICE` | No | macOS TTS voice name |
| `TTS_RATE` | No | macOS TTS speech rate (wpm) |
| `CALL_DURATION_MS` | No (default 120000) | Auto-hangup safety timer |
| `DEBUG_CALL_EVENTS` | No | Set to `1` to log WASM call events |

### First-run authentication

On first `connect()`, a QR code prints in the terminal and is saved to `<authDir>/qr.png`. Scan it in **WhatsApp → Settings → Linked Devices → Link a Device**. The session persists in `authDir/` — no rescan on subsequent runs.

> `authDir/` contains your linked-device session keys. **Never commit it.** It's in `.gitignore`.

## Examples

```bash
# Phase 0 — play a file to a callee (proves the WASM call path)
npm run phase0:call -- +1234567890

# Phase 1 — stream a generated sine tone (proves pushAudio, no file/ffmpeg)
npm run phase1:call -- +1234567890

# Full ElevenLabs agent on a WhatsApp call
ELEVENLABS_AGENT_ID=... npm run call-agent -- +1234567890

# macOS TTS on a WhatsApp call
TTS_VOICE=Samantha npm run mac-tts:call -- +1234567890 "Hello there!"
```

## Project structure

```
src/
  client.ts              AgentCaller + CallSession (orchestrator)
  config.ts              config types + env loading
  index.ts               public API exports
  whatsapp/
    voip-client.ts       WhatsAppClient wrapper (injects PushAudioFeeder)
    push-audio-feeder.ts streaming ring-buffer feeder (replaces file-only feeder)
    ring-buffer.ts       sample-level ring buffer with overflow/underflow stats
  elevenlabs/
    bridge.ts            ElevenLabs WebSocket client (audio routing, ping/pong)
    messages.ts          typed client/server message definitions
  audio/
    pcm.ts               Float32 ↔ Int16 ↔ base64 conversions, downmix
    resampler.ts         linear + streaming resampler
    mac-tts.ts           macOS `say` TTS source
  vendor/
    baileys-caller/      vendored WhatsApp Web WASM stack (MIT)
      assets/wasm/       whatsapp.wasm, loader.js, worker-modules.js
test/
  ring-buffer.test.ts          10 tests
  pcm.test.ts                  12 tests
  resampler.test.ts            10 tests
  bridge.test.ts               10 tests (mocked WebSocket)
  mac-tts.test.ts               5 tests (real macOS `say`)
  agent-caller.integration.ts  10 tests (mocked WhatsApp + ElevenLabs)
  helpers/mocks.ts             shared mock implementations
scripts/
  phase0-call.mjs        play a file to a callee
  phase1-sine-push.mjs   stream a generated tone
  call-agent.mjs         full ElevenLabs agent example
  mac-tts-call.mjs       macOS TTS example
```

## Testing

```bash
npm test          # run all 57 tests
npm run test:watch # watch mode
```

Tests are fully mocked (no network, no real WhatsApp calls) except `mac-tts.test.ts` which runs the real `say` + `ffmpeg` pipeline on macOS.

## Limitations & risks

- **Outbound 1:1 voice calls only.** No inbound calls, group calls, or video (WASM backend limitation).
- **WhatsApp WASM is reverse-engineered.** A WhatsApp Web update can break it. Run `npm run fetch-wasm` to refresh the WASM assets from a live WhatsApp Web session (instructions in `AGENTS.md`).
- **ToS / ban risk.** Automating a personal WhatsApp account violates WhatsApp's Terms of Service. Use a dedicated secondary number; rate-limit calls. This is for personal/experimental use.
- **macOS only for TTS.** `MacTtsSource` requires the `say` command. The core library works on Linux/Windows (with the right `@roamhq/wrtc` prebuilt).
- **One active call at a time** per `VoipClient` instance. For concurrent calls, use multiple instances.
- **Regional restrictions.** WhatsApp calling is blocked in some regions (e.g. UAE) without a VPN.

## Refreshing WASM assets

If a WhatsApp update breaks call setup:

```bash
# 1. Open Chrome with remote debugging and log into web.whatsapp.com
open -na "Google Chrome" --args --remote-debugging-port=9222

# 2. Fetch fresh WASM resources
npm run fetch-wasm

# 3. Copy assets into the expected location
cp src/vendor/baileys-caller/src/lib/wasm-resources/* src/vendor/baileys-caller/assets/wasm/

# 4. Rebuild
npm run build:all
```

## License

MIT. The vendored `baileys-caller` is also MIT (© ShellTear).
