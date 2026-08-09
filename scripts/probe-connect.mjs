/**
 * Debug probe: trace what happens during VoipClient.connect().
 */
import { VoipClient } from "../src/vendor/baileys-caller/dist/index.mjs";

process.on("uncaughtException", (e) => console.error("[probe] uncaughtException:", e));
process.on("unhandledRejection", (e) => console.error("[probe] unhandledRejection:", e));
process.on("exit", (code) => console.log("[probe] process exit, code=", code));

console.log("[probe] constructing VoipClient...");
const client = new VoipClient({ authDir: "./auth" });
console.log("[probe] calling connect()...");
try {
  const p = client.connect();
  console.log("[probe] connect() returned a", p && typeof p.then === "function" ? "Promise" : typeof p);
  await p;
  console.log("[probe] connect() RESOLVED");
} catch (e) {
  console.error("[probe] connect() THREW:", e);
}
console.log("[probe] after connect, event loop refs?", process.getActiveResourcesInfo?.());
