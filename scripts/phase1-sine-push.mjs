/**
 * Phase 1 — test the PushAudioFeeder by streaming a generated sine tone into a
 * live WhatsApp call (no file, no ffmpeg).
 *
 *   node scripts/phase1-sine-push.mjs <phoneNumber>
 *
 *   phoneNumber   The callee's WhatsApp number (E.164, e.g. +91...).
 *
 * First run reuses ./auth from Phase 0 (no rescan unless it expired).
 * The callee should hear a 440 Hz tone generated in real time, pushed via
 * call.pushAudio(Float32Array) — proving the streaming feeder works.
 *
 * Environment:
 *   CALL_DURATION_MS  Auto-hangup after N ms (default: 20000)
 *   DEBUG_CALL_EVENTS  Set to 1 to log all WASM call events.
 */
import { WhatsAppClient } from "../dist/whatsapp/voip-client.js";

const [, , phoneNumber] = process.argv;
const durationMs = Number(process.env.CALL_DURATION_MS) || 20_000;

if (!phoneNumber) {
  console.error("Usage: node scripts/phase1-sine-push.mjs <phoneNumber>");
  console.error('  e.g. node scripts/phase1-sine-push.mjs +919509605119');
  process.exit(1);
}

const normalized = phoneNumber.replace(/\D/g, "");
console.log(`[phase1] target=${normalized} duration=${durationMs}ms`);
console.log("[phase1] Connecting (PushAudioFeeder mode)...");

const client = new WhatsAppClient({ authDir: "./auth", feederOptions: { debug: true } });

try {
  await client.connect();
} catch (e) {
  console.error("[phase1] WhatsApp connection failed:", e?.message || e);
  process.exit(1);
}
console.log("[phase1] Connected. Placing call...");

const call = await client.call(normalized, { audioSource: "silence", durationMs });

call.on("ringing", () => console.log("[phase1] -> Ringing"));
call.on("connected", () => {
  console.log("[phase1] -> Call connected. Streaming 440 Hz sine tone via pushAudio()...");
  startSineGenerator(call);
});
call.on("audio", (pcm) => { /* callee audio — quiet unless debugging */ });
call.on("ended", (reason) => console.log(`[phase1] -> Call ended: ${reason}`));
call.on("error", (err) => console.error("[phase1] -> Call error:", err));

console.log(`[phase1] Call id=${call.callId}`);
await call.waitForEnd();

client.disconnect();
console.log("[phase1] Done.");
process.exit(0);

// ─── sine generator ──────────────────────────────────────────────────────────
// Generates a continuous 440 Hz tone as 20ms Float32 frames (320 samples @ 16kHz)
// and pushes them into the call. Runs on a timer at real-time cadence.
function startSineGenerator(call) {
  const sampleRate = 16000;
  const frequency = 440;
  const framesPerChunk = 320; // 20ms @ 16kHz
  const chunkIntervalMs = (framesPerChunk / sampleRate) * 1000;
  let phase = 0;
  const phaseIncrement = (2 * Math.PI * frequency) / sampleRate;
  let timer = null;

  const generateAndPush = () => {
    const chunk = new Float32Array(framesPerChunk);
    for (let i = 0; i < framesPerChunk; i++) {
      chunk[i] = Math.sin(phase) * 0.3; // amplitude 0.3 to avoid clipping/loudness
      phase += phaseIncrement;
    }
    call.pushAudio(chunk);
  };

  // Pre-fill the feeder buffer so it doesn't underflow at the start.
  for (let i = 0; i < 25; i++) generateAndPush(); // ~0.5s of buffered audio

  timer = setInterval(generateAndPush, chunkIntervalMs);

  call.on("ended", () => { if (timer) clearInterval(timer); });
}
