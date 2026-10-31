import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

if (!existsSync("dist/manifest.json")) { console.error("dist/ missing: run npm run build first"); process.exit(1); }
const { version } = JSON.parse(readFileSync("dist/manifest.json", "utf8"));
mkdirSync("release", { recursive: true });
const base = resolve("release", `parakeet-extension-${version}`);
rmSync(`${base}.tar.gz`, { force: true }); rmSync(`${base}.zip`, { force: true });
// tarball extracts to ./parakeet-extension/ ; zip has manifest.json at root (Chrome Web Store format)
// GNU tar renames with --transform, BSD tar (macOS) with -s.
const gnu = execFileSync("tar", ["--version"]).toString().includes("GNU");
execFileSync("tar", ["-czf", `${base}.tar.gz`, ...(gnu ? ["--transform", "s,^dist,parakeet-extension,"] : ["-s", ",^dist,parakeet-extension,"]), "dist"], { stdio: "inherit" });
execFileSync("zip", ["-qr", `${base}.zip`, "."], { cwd: "dist", stdio: "inherit" });
console.log(`Packaged:\n  ${base}.tar.gz\n  ${base}.zip`);
