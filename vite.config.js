import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";
// @ts-expect-error node builtins
import fs from "node:fs";
// @ts-expect-error node builtins
import path from "node:path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// ── Build-Version automatisch hochzählen ─────────────────────────────────────
const versionFile = path.resolve("version.json");
const verData = JSON.parse(fs.readFileSync(versionFile, "utf-8"));

// Versionsnummer als Integer (z.B. "0.823" → 823), +1, zurück zu "0.824"
const oldNum = Math.round(parseFloat(verData.version) * 1000);
const newNum = oldNum + 1;
const newVersion = (newNum / 1000).toFixed(3);

// Build-Datum/Zeit: dd.mm.yyyy hh:mm
const now = new Date();
/** @param {number} n */ const pad = (n) => String(n).padStart(2, "0");
const buildDate = `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

// Zurückschreiben
fs.writeFileSync(versionFile, JSON.stringify({ version: newVersion, buildDate }, null, 2));

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [sveltekit()],
  define: {
    __APP_VERSION__: JSON.stringify(newVersion),
    __BUILD_DATE__:  JSON.stringify(buildDate),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  build: {
    chunkSizeWarningLimit: 4000, // Desktop-App: Chunk-Größe irrelevant
  },
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
