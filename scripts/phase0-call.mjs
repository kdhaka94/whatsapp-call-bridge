/**
 * Phase 0 — prove the vendored WhatsApp Web WASM stack places a real call.
 *
 *   node scripts/phase0-call.mjs <phoneNumber> [audioSource]
 *
 *   phoneNumber   Digits only or E.164, e.g. "+1234567890" or "1234567890"
 *                 (the number you will call FROM your linked WhatsApp)
 *   audioSource   Optional path to MP3/WAV to play, or "silence".
 *                 Defaults to ./media/test-tone.wav
 *
 * First run prints a QR — scan it in WhatsApp > Settings > Linked Devices.
 * The auth state is stored in ./auth (treat it as a credential).
 *
 * Environment:
 *   CALL_DURATION_MS  Auto-hangup after N ms (default: 30000)
 */
import { VoipClient } from "../src/vendor/baileys-caller/dist/index.mjs";
import { resolve } from "node:path";

const [, , phoneNumber, audioSourceArg] = process.argv;
const durationMs = Number(process.env.CALL_DURATION_MS) || 30_000;

if (!phoneNumber) {
  console.error("Usage: node scripts/phase0-call.mjs <phoneNumber> [audioSource]");
  console.error('  e.g. node scripts/phase0-call.mjs +1234567890 ./media/test-tone.wav');
  process.exit(1);
}

const audioSource = audioSourceArg ?? resolve("./media/test-tone.wav");
const normalized = phoneNumber.replace(/\D/g, "");

console.log(`[phase0] auth dir:    ${resolve("./auth")}`);
console.log(`[phase0] target:      ${normalized}`);
console.log(`[phase0] audioSource: ${audioSource}`);
console.log(`[phase0] duration:    ${durationMs}ms`);
console.log(`[phase0] Connecting to WhatsApp...`);

const client = new VoipClient({ authDir: "./auth" });

try {
  await client.connect();
} catch (e) {
  console.error("[phase0] WhatsApp connection failed:", e?.message || e);
  if (e?.data) console.error("[phase0]   data:", JSON.stringify(e.data));
  process.exit(1);
}
console.log("[phase0] Connected. Placing call...");

const call = await client.call(normalized, { audioSource, durationMs });

call.on("ringing", () => console.log("[phase0] -> Ringing"));
call.on("connected", () => console.log("[phase0] -> Call connected (audio should be playing to callee)"));
call.on("audio", (pcm) => {
  // 16 kHz mono Float32Array from the remote peer. Keep this quiet unless debugging.
});
call.on("ended", (reason) => console.log(`[phase0] -> Call ended: ${reason}`));
call.on("error", (err) => console.error("[phase0] -> Call error:", err));

console.log(`[phase0] Call id=${call.callId}`);
await call.waitForEnd();

client.disconnect();
console.log("[phase0] Done.");
process.exit(0);
