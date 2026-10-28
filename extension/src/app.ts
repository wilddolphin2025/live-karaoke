const LANGS = ["auto","bg","cs","da","de","el","en","es","et","fi","fr","hr","hu","it","lt","lv","mt","nl","pl","pt","ro","ru","sk","sl","sv","uk"];
const DEFAULT_SERVER = "http://192.168.8.226:30800";
const EXT_MIME: Record<string, string> = { wav: "audio/wav", mp3: "audio/mpeg", flac: "audio/flac", ogg: "audio/ogg", m4a: "audio/mp4", webm: "audio/webm" };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const server = $<HTMLInputElement>("server"), lang = $<HTMLSelectElement>("lang");
const drop = $<HTMLLabelElement>("drop"), fileInput = $<HTMLInputElement>("file");
const status = $("status"), errBox = $("error"), meta = $("meta"), out = $("out");
const copyBtn = $<HTMLButtonElement>("copy"), dlBtn = $<HTMLButtonElement>("dl");

interface Utterance { start: number; end: number; transcript: string }
let plainText = "", baseName = "transcript";

for (const l of LANGS) lang.add(new Option(l, l));
chrome.storage.local.get({ server: DEFAULT_SERVER, language: "auto" }).then((s) => {
  server.value = s.server as string; lang.value = s.language as string;
});
server.addEventListener("change", () => chrome.storage.local.set({ server: server.value.trim().replace(/\/+$/, "") || DEFAULT_SERVER }));
lang.addEventListener("change", () => chrome.storage.local.set({ language: lang.value }));

drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); const f = e.dataTransfer?.files[0]; if (f) void handle(f); });
drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") fileInput.click(); });
fileInput.addEventListener("change", () => { const f = fileInput.files?.[0]; if (f) void handle(f); fileInput.value = ""; });

const fmt = (s: number) => { const m = Math.floor(s / 60); return `${String(m).padStart(2, "0")}:${(s - m * 60).toFixed(2).padStart(5, "0")}`; };
const showError = (msg: string) => { errBox.textContent = msg; errBox.hidden = false; };

async function ensurePermission(base: string): Promise<boolean> {
  const origin = new URL(base).origin + "/*";
  if (await chrome.permissions.contains({ origins: [origin] })) return true;
  return chrome.permissions.request({ origins: [origin] });
}

function upload(url: string, file: File, mime: string, onProgress: (p: number) => void): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("Content-Type", mime);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.upload.onload = () => onProgress(1);
    xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText });
    xhr.onerror = () => reject(new Error("Network error: could not reach the server. Check the URL, that the service is up, and (for https://slim) that the certificate has been accepted."));
    xhr.ontimeout = () => reject(new Error("Request timed out"));
    xhr.send(file);
  });
}

async function handle(file: File) {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!(ext in EXT_MIME) && !file.type.startsWith("audio/")) { showError(`Unsupported file type: ${file.name}`); return; }
  const mime = file.type || EXT_MIME[ext] || "application/octet-stream";
  const base = (server.value.trim() || DEFAULT_SERVER).replace(/\/+$/, "");
  errBox.hidden = true; out.textContent = ""; meta.textContent = ""; copyBtn.disabled = dlBtn.disabled = true;
  baseName = file.name.replace(/\.[^.]+$/, "") || "transcript";

  try { if (!(await ensurePermission(base))) { showError(`Permission to access ${base} was denied.`); return; } }
  catch { showError(`Invalid server URL: ${base}`); return; }

  const url = `${base}/v1/listen?language=${encodeURIComponent(lang.value)}&utterances=true`;
  const t0 = performance.now(); let phase = "Uploading", pct = 0;
  const render = () => {
    const el = ((performance.now() - t0) / 1000).toFixed(1);
    status.innerHTML = `<span class="spin"></span>${phase}${phase === "Uploading" ? ` ${Math.round(pct * 100)}%` : "…"} — ${el}s`;
  };
  const timer = setInterval(render, 100); render();
  drop.classList.add("busy");
  try {
    const r = await upload(url, file, mime, (p) => { pct = p; if (p >= 1) phase = "Transcribing"; });
    let data: any; try { data = JSON.parse(r.body); } catch { data = null; }
    if (r.status < 200 || r.status >= 300) {
      const hint = r.status === 503 ? " (server busy — try again shortly)" : r.status === 504 ? " (server timed out)" : "";
      showError(`Error ${r.status}${hint}: ${data?.err_msg ?? (r.body.slice(0, 300) || "unknown error")}` +
        (data?.err_code ? `\nCode: ${data.err_code}` : "") + (data?.request_id ? `\nRequest ID: ${data.request_id}` : ""));
      status.textContent = `Failed after ${((performance.now() - t0) / 1000).toFixed(1)}s`;
      return;
    }
    const transcript: string = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
    const utts: Utterance[] = data?.results?.utterances ?? [];
    const models = data?.metadata?.models; const model = Array.isArray(models) ? models.join(", ") : (models ?? "unknown");
    meta.textContent = `Model: ${model}${data?.metadata?.duration ? ` · Audio ${Number(data.metadata.duration).toFixed(1)}s` : ""}`;
    if (utts.length) {
      for (const u of utts) {
        const d = document.createElement("div"); d.className = "u";
        const t = document.createElement("span"); t.className = "t"; t.textContent = `[${fmt(u.start)} – ${fmt(u.end)}]`;
        d.append(t, document.createTextNode(u.transcript)); out.append(d);
      }
      plainText = utts.map((u) => `[${fmt(u.start)} - ${fmt(u.end)}] ${u.transcript}`).join("\n") + `\n\n${transcript}\n`;
    } else { out.textContent = transcript || "(empty transcript)"; plainText = transcript + "\n"; }
    copyBtn.disabled = dlBtn.disabled = false;
    status.textContent = `Done in ${((performance.now() - t0) / 1000).toFixed(1)}s — ${file.name}`;
  } catch (e) {
    showError((e as Error).message); status.textContent = "";
  } finally { clearInterval(timer); drop.classList.remove("busy"); }
}

copyBtn.addEventListener("click", async () => { await navigator.clipboard.writeText(plainText); copyBtn.textContent = "Copied!"; setTimeout(() => (copyBtn.textContent = "Copy"), 1200); });
dlBtn.addEventListener("click", () => {
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([plainText], { type: "text/plain" }));
  a.download = `${baseName}.txt`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
export {};
