/**
 * Example: place a WhatsApp call, speak via macOS TTS, and transcribe the
 * callee's voice using any STT provider.
 *
 *   node scripts/stt-call.mjs <phoneNumber> "text to speak" <provider>
 *
 *   phoneNumber   The callee's WhatsApp number (E.164).
 *   text          Text to speak via macOS TTS (quote it).
 *   provider      STT provider: "assemblyai" | "deepgram" | "whisper" | "mac" (default: "mac")
 *
 * Environment:
 *   ASSEMBLYAI_API_KEY  Required for provider=assemblyai
 *   DEEPGRAM_API_KEY    Required for provider=deepgram
 *   OPENAI_API_KEY      Required for provider=whisper (or GROQ_API_KEY)
 *   GROQ_API_KEY        Alt for provider=whisper (uses Groq endpoint)
 *   TTS_VOICE           macOS TTS voice (default: system)
 *   CALL_DURATION_MS    Auto-hangup (default: 60000)
 */
import { WhatsAppClient, MacTtsSource, AssemblyAIStt, DeepgramStt, WhisperStt, MacStt } from "../dist/index.js";

const [, , phoneNumber, ...textParts] = process.argv;
const text = textParts.slice(0, -1).join(" ") || textParts.join(" ");
const providerName = process.argv[process.argv.length - 1] === "assemblyai" ||
  process.argv[process.argv.length - 1] === "deepgram" ||
  process.argv[process.argv.length - 1] === "whisper" ||
  process.argv[process.argv.length - 1] === "mac"
  ? process.argv[process.argv.length - 1] : "mac";

const durationMs = Number(process.env.CALL_DURATION_MS) || 60_000;
const voice = process.env.TTS_VOICE;

if (!phoneNumber) {
  console.error('Usage: node scripts/stt-call.mjs <phoneNumber> "text to speak" [provider]');
  console.error('  provider: assemblyai | deepgram | whisper | mac (default: mac)');
  console.error('  e.g. ASSEMBLYAI_API_KEY=... node scripts/stt-call.mjs +919509605119 "Hello!" assemblyai');
  process.exit(1);
}

// Resolve the actual text (handle provider arg).
const actualText = textParts.length > 1 &&
  ["assemblyai", "deepgram", "whisper", "mac"].includes(textParts[textParts.length - 1])
  ? textParts.slice(0, -1).join(" ") : textParts.join(" ");

const normalized = phoneNumber.replace(/\D/g, "");
console.log(`[stt] target=${normalized} provider=${providerName} text="${actualText}"`);

// Create STT provider.
let stt;
switch (providerName) {
  case "assemblyai": stt = new AssemblyAIStt({}); break;
  case "deepgram": stt = new DeepgramStt({}); break;
  case "whisper": stt = new WhisperStt({}); break;
  case "mac": stt = new MacStt({}); break;
  default: console.error(`Unknown provider: ${providerName}`); process.exit(1);
}

const client = new WhatsAppClient({ authDir: "./auth" });
const tts = new MacTtsSource();

process.on("SIGINT", async () => {
  console.log("\n[stt] SIGINT — stopping...");
  await stt.stop();
  tts.stop();
  client.disconnect();
  process.exit(0);
});

console.log("[stt] Connecting to WhatsApp...");
try { await client.connect(); } catch (e) { console.error("[stt] WhatsApp failed:", e.message); process.exit(1); }
console.log("[stt] Connected. Placing call...");

const call = await client.call(normalized, { audioSource: "silence", durationMs });

// Start STT.
await stt.start({
  onPartial: (t) => console.log(`\n[stt] callee (partial): ${t}`),
  onFinal: (t) => console.log(`\n[stt] callee (final): ${t}`),
  onError: (e) => console.error(`\n[stt] STT error: ${e.message}`),
});

call.on("ringing", () => console.log("[stt] -> Ringing"));
call.on("connected", async () => {
  console.log("[stt] -> Connected. Speaking + listening...");
  // Speak via TTS.
  if (actualText) {
    tts.speak(actualText, { voice }, {
      onChunk: (pcm) => call.pushAudio(pcm),
      onEnd: () => console.log("[stt] -> TTS done. Listening to callee..."),
      onError: (e) => console.error("[stt] TTS error:", e.message),
    });
  }
});

// Pipe callee audio → STT.
call.on("audio", (pcm) => stt.feedAudio(pcm));

call.on("ended", async (reason) => {
  console.log(`\n[stt] -> Call ended: ${reason}`);
  await stt.stop();
  tts.stop();
  client.disconnect();
  process.exit(0);
});

call.on("error", (err) => { console.error("[stt] Call error:", err); client.disconnect(); process.exit(1); });

await call.waitForEnd();
