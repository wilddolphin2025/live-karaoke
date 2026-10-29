import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist/icons", { recursive: true });
const { version } = JSON.parse(readFileSync("static/manifest.json", "utf8"));
// Local defaults (gitignored extension/local.env, or the environment): LK_SERVER=http://<ip>:30800 becomes the
// default server and gets a host permission; LK_EXTRA_ORIGINS="https://myhost/*" adds more host permissions.
const env = { ...Object.fromEntries((existsSync("local.env") ? readFileSync("local.env", "utf8") : "").split("\n")
  .map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && l.includes("="))
  .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")])), ...process.env };
const DEFAULT_SERVER = (env.LK_SERVER || "").replace(/\/+$/, "");
const origins = [...(DEFAULT_SERVER ? [`${new URL(DEFAULT_SERVER).protocol}//${new URL(DEFAULT_SERVER).hostname}/*`] : []),
  ...(env.LK_EXTRA_ORIGINS || "").split(/[\s,]+/).filter(Boolean)];
// Baked into both bundles: the page checks the service worker runs the same build.
await build({ define: { __BUILD__: JSON.stringify(version), __DEFAULT_SERVER__: JSON.stringify(DEFAULT_SERVER) }, entryPoints: ["src/background.ts", "src/app.ts"], bundle: true, outdir: "dist", format: "iife", target: "chrome110", minify: false, logLevel: "info" });
cpSync("static", "dist", { recursive: true });
const manifest = JSON.parse(readFileSync("dist/manifest.json", "utf8"));
manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), ...origins])];
writeFileSync("dist/manifest.json", JSON.stringify(manifest, null, 2) + "\n");
console.log(`Default server: ${DEFAULT_SERVER || "(none: set in Settings)"}; host_permissions: ${JSON.stringify(manifest.host_permissions)}`);

// Generated icon: green rounded square with a white waveform.
const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
function png(s) {
  const raw = Buffer.alloc(s * (s * 4 + 1)); const r = s * 0.2; const bars = [0.35, 0.7, 1, 0.55, 0.8, 0.4];
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const o = y * (s * 4 + 1) + 1 + x * 4;
    const dx = Math.max(r - x - 0.5, x + 0.5 - (s - r), 0), dy = Math.max(r - y - 0.5, y + 0.5 - (s - r), 0);
    if (dx * dx + dy * dy > r * r) continue;
    let col = [34, 160, 110];
    const bw = s / 13, bi = Math.floor((x - bw * 0.5) / (bw * 2)), inBar = (x - bw * 0.5) % (bw * 2) < bw;
    if (bi >= 0 && bi < 6 && inBar && Math.abs(y - s / 2) < bars[bi] * s * 0.32) col = [255, 255, 255];
    raw.set([...col, 255], o);
  }
  const h = Buffer.alloc(13); h.writeUInt32BE(s, 0); h.writeUInt32BE(s, 4); h.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", h), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
for (const s of [16, 48, 128]) writeFileSync(`dist/icons/icon${s}.png`, png(s));
console.log("Built extension into dist/");
