import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist/icons", { recursive: true });
const { version } = JSON.parse(readFileSync("static/manifest.json", "utf8"));
// Baked into both bundles: the page checks the service worker runs the same build.
await build({ define: { __BUILD__: JSON.stringify(version) }, entryPoints: ["src/background.ts", "src/app.ts"], bundle: true, outdir: "dist", format: "iife", target: "chrome110", minify: false, logLevel: "info" });
cpSync("static", "dist", { recursive: true });

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
