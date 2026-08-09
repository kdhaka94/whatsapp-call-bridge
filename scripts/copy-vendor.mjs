/**
 * Copy vendored baileys-caller dist + assets into our dist/ so the published
 * npm package is self-contained (no file: dependency).
 *
 * After this runs, dist/ contains:
 *   dist/index.js                    ← our compiled library
 *   dist/whatsapp/voip-client.js     ← imports ../vendor/baileys-caller/dist/index.mjs
 *   dist/vendor/baileys-caller/dist/ ← vendored compiled .mjs files
 *   dist/vendor/baileys-caller/assets/wasm/ ← whatsapp.wasm, loader.js, worker-modules.js
 */
import { cpSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const vendorSrc = resolve(root, "src/vendor/baileys-caller");
const distVendor = resolve(root, "dist/vendor/baileys-caller");

if (!existsSync(vendorSrc)) {
  console.error("[copy-vendor] src/vendor/baileys-caller not found. Run npm run vendor:build first.");
  process.exit(1);
}

// Copy dist/*.mjs (compiled vendored code)
const distSrc = resolve(vendorSrc, "dist");
if (!existsSync(distSrc)) {
  console.error("[copy-vendor] src/vendor/baileys-caller/dist not found. Run npm run vendor:build first.");
  process.exit(1);
}
mkdirSync(resolve(distVendor, "dist"), { recursive: true });
cpSync(distSrc, resolve(distVendor, "dist"), { recursive: true });
console.log(`[copy-vendor] Copied dist/ → dist/vendor/baileys-caller/dist/`);

// Copy assets/wasm/ (WASM binary + loader + worker modules)
const assetsSrc = resolve(vendorSrc, "assets");
if (existsSync(assetsSrc)) {
  mkdirSync(resolve(distVendor, "assets"), { recursive: true });
  cpSync(assetsSrc, resolve(distVendor, "assets"), { recursive: true });
  console.log(`[copy-vendor] Copied assets/ → dist/vendor/baileys-caller/assets/`);
}

console.log("[copy-vendor] Done. dist/ is self-contained for npm publish.");
