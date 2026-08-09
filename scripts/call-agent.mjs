/**
 * Full end-to-end example: place a WhatsApp call and bridge it to an ElevenLabs
 * Conversational AI agent.
 *
 *   node scripts/call-agent.mjs <phoneNumber>
 *
 * Environment (required):
 *   ELEVENLABS_AGENT_ID   Your ElevenLabs agent ID (public agent).
 *   ELEVENLABS_SIGNED_URL Optional: use a signed URL instead (private agent).
 *
 * Environment (optional):
 *   CALLING_AGENT_AUTH_DIR  WhatsApp auth dir (default ./auth)
 *   CALL_DURATION_MS        Auto-hangup after N ms (default 120000)
 *   DEBUG_CALL_EVENTS       Set to 1 to log WASM call events.
 *
 * First run prints a QR (also saved to <authDir>/qr.png) — scan it in
 * WhatsApp > Settings > Linked Devices.
 *
 * IMPORTANT: configure your ElevenLabs agent's TTS output format to
 * "PCM 16000 Hz" in the ElevenLabs dashboard (Agent → Voice → TTS output
 * format) so no resampling is needed on the agent→call path.
 */
import { AgentCaller, configFromEnv } from "../dist/index.js";

const [, , phoneNumber] = process.argv;
const durationMs = Number(process.env.CALL_DURATION_MS) || 120_000;

if (!phoneNumber) {
  console.error("Usage: node scripts/call-agent.mjs <phoneNumber>");
  console.error('  e.g. CALL_DURATION_MS=60000 node scripts/call-agent.mjs +919509605119');
  console.error("\nRequired env: ELEVENLABS_AGENT_ID (or ELEVENLABS_SIGNED_URL)");
  process.exit(1);
}

const config = (() => {
  try {
    return configFromEnv({ feederDebug: true });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
})();

const caller = new AgentCaller(config);
let session = null;

// Graceful shutdown on Ctrl-C.
process.on("SIGINT", async () => {
  console.log("\n[agent] SIGINT — hanging up...");
  try { if (session) await session.end(); } catch {}
  caller.disconnect();
  process.exit(0);
});

console.log(`[agent] Connecting to WhatsApp (auth: ${config.authDir})...`);
try {
  await caller.connect();
} catch (e) {
  console.error("[agent] WhatsApp connection failed:", e?.message || e);
  process.exit(1);
}
console.log("[agent] Connected. Placing call + opening ElevenLabs agent session...");

session = await caller.call(phoneNumber, { durationMs });

session.on("ringing", () => console.log("[agent] -> Ringing"));
session.on("connected", () => console.log("[agent] -> Connected. Agent is live on the call."));
session.on("transcript", (text) => console.log(`[agent] user: ${text}`));
session.on("tentativeTranscript", (text) => process.stdout.write(`\r[agent] user(tentative): ${text}   `));
session.on("agentResponse", (text) => console.log(`[agent] agent: ${text}`));
session.on("interruption", () => console.log("[agent] -> user interrupted the agent"));
session.on("error", (err) => console.error("[agent] -> error:", err.message));
session.on("ended", (reason) => console.log(`[agent] -> Call ended: ${reason}`));

console.log("[agent] Call placed. Waiting for end...");
await session.waitForEnd();

caller.disconnect();
console.log("[agent] Done.");
process.exit(0);
