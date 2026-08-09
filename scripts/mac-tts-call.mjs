/**
 * Example: place a WhatsApp call and speak via macOS built-in TTS (`say`).
 *
 *   node scripts/mac-tts-call.mjs <phoneNumber> "Hello, this is a test call"
 *
 *   phoneNumber   The callee's WhatsApp number (E.164, e.g. +91...).
 *   text          The text to speak (quote it).
 *
 * Environment:
 *   CALL_DURATION_MS   Auto-hangup after N ms (default: 60000)
 *   TTS_VOICE          Voice name (e.g. "Samantha", "Daniel", "Karen"). Default: system voice.
 *   TTS_RATE           Speech rate in words/min (default: 175).
 *
 * This uses NO ElevenLabs — it streams the macOS `say` command's audio into the
 * call via the PushAudioFeeder, and receives the callee's voice as Float32 PCM
 * on the `audio` event (printed as amplitude for verification).
 *
 * macOS-only. Requires `say` and `ffmpeg` on PATH.
 */
import { WhatsAppClient, MacTtsSource } from "../dist/index.js";

const [, , phoneNumber, ...textParts] = process.argv;
const text = textParts.join(" ");
const durationMs = Number(process.env.CALL_DURATION_MS) || 60_000;
const voice = process.env.TTS_VOICE;
const rate = process.env.TTS_RATE ? Number(process.env.TTS_RATE) : undefined;

if (!phoneNumber || !text) {
  console.error('Usage: node scripts/mac-tts-call.mjs <phoneNumber> "text to speak"');
  console.error('  e.g. TTS_VOICE=Samantha node scripts/mac-tts-call.mjs +919509605119 "Hello there!"');
  console.error("\nEnv: TTS_VOICE, TTS_RATE, CALL_DURATION_MS");
  process.exit(1);
}

const normalized = phoneNumber.replace(/\D/g, "");
console.log(`[mac-tts] target=${normalized}`);
console.log(`[mac-tts] text="${text}"`);
console.log(`[mac-tts] voice=${voice ?? "system default"} rate=${rate ?? 175}`);

const client = new WhatsAppClient({ authDir: "./auth", feederOptions: { debug: true } });
const tts = new MacTtsSource();

// Graceful shutdown.
process.on("SIGINT", async () => {
  console.log("\n[mac-tts] SIGINT — stopping...");
  tts.stop();
  client.disconnect();
  process.exit(0);
});

console.log("[mac-tts] Connecting to WhatsApp...");
try {
  await client.connect();
} catch (e) {
  console.error("[mac-tts] WhatsApp connection failed:", e?.message || e);
  process.exit(1);
}
console.log("[mac-tts] Connected. Placing call...");

const call = await client.call(normalized, { audioSource: "silence", durationMs });

let hasSpoken = false;

call.on("ringing", () => console.log("[mac-tts] -> Ringing"));
call.on("connected", async () => {
  console.log("[mac-tts] -> Call connected. Speaking via macOS TTS...");
  hasSpoken = true;
  try {
    await tts.speak(text, { voice, rate }, {
      onChunk: (pcm) => call.pushAudio(pcm),
      onEnd: () => console.log("[mac-tts] -> TTS finished. Listening for callee response..."),
      onError: (err) => console.error("[mac-tts] -> TTS error:", err.message),
    });
  } catch (err) {
    console.error("[mac-tts] -> TTS failed:", err.message);
  }
});

// Receive callee's voice — print amplitude as a simple VU meter.
call.on("audio", (pcm) => {
  let max = 0;
  for (let i = 0; i < pcm.length; i++) {
    const abs = Math.abs(pcm[i]);
    if (abs > max) max = abs;
  }
  const bars = Math.round(max * 30);
  process.stdout.write(`\r[mac-tts] callee audio: ${"█".repeat(bars)}${" ".repeat(30 - bars)} ${(max * 100).toFixed(0)}%  `);
});

call.on("ended", (reason) => {
  console.log(`\n[mac-tts] -> Call ended: ${reason}`);
  tts.stop();
  client.disconnect();
  process.exit(0);
});
call.on("error", (err) => {
  console.error("[mac-tts] -> Call error:", err);
  tts.stop();
  client.disconnect();
  process.exit(1);
});

console.log(`[mac-tts] Call id=${call.callId}`);
await call.waitForEnd();
client.disconnect();
console.log("[mac-tts] Done.");
process.exit(0);
