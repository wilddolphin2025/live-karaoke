import { BUILD, needsTranslation, summaryText, DEFAULT_SERVER, LANGS, TRANSLATE_LANGS, JobState, Word, TranslationState, clearAudio, getAudio, getState, putAudio, setState } from "./shared";

const EXT_MIME: Record<string, string> = { wav: "audio/wav", mp3: "audio/mpeg", flac: "audio/flac", ogg: "audio/ogg", m4a: "audio/mp4", webm: "audio/webm",
  mp4: "video/mp4", mov: "video/quicktime", mkv: "video/x-matroska" };
const VIDEO_EXT = new Set(["mp4", "mov", "mkv"]);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
// Main view (file, transcript, translation) vs Settings view (options + version info), toggled by the gear.
const mainView = $("mainview"), settingsView = $("settings"), summary = $("summary");
const showSettings = (on: boolean) => { settingsView.hidden = !on; mainView.hidden = on; if (!on) updateSummary(); };
$("gear").addEventListener("click", () => showSettings(true));
$("back").addEventListener("click", () => showSettings(false));
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !settingsView.hidden) { e.preventDefault(); showSettings(false); } });
function updateSummary() {
  summary.textContent = summaryText(lang.value, trBox.checked, trLang.value);
}
const server = $<HTMLInputElement>("server"), lang = $<HTMLSelectElement>("lang");
const trBox = $<HTMLInputElement>("tr"), trLang = $<HTMLSelectElement>("trlang");
const drop = $<HTMLLabelElement>("drop"), fileInput = $<HTMLInputElement>("file");
const statusEl = $("status"), errBox = $("error"), meta = $("meta"), out = $("out"), versions = $("versions");
const trPane = $("trpane"), trOut = $("trout"), trStatus = $("trstatus");
const audioEl = $<HTMLAudioElement>("player"), videoEl = $<HTMLVideoElement>("vplayer");
// Whichever element is showing the current file; highlighting follows its clock.
let player: HTMLMediaElement = audioEl;
const clearBtn = $<HTMLButtonElement>("clear");
const copyBtn = $<HTMLButtonElement>("copy"), dlBtn = $<HTMLButtonElement>("dl"), pinBtn = $<HTMLButtonElement>("pin");

const isPanel = new URLSearchParams(location.search).has("panel");
if (isPanel) { document.body.classList.add("panel"); pinBtn.hidden = true; }

let lastJob: JobState = { phase: "idle" }, baseName = "transcript", timer: ReturnType<typeof setInterval> | undefined;
let spans: { el: HTMLElement; start: number; end: number }[] = [];
let trSpans: { el: HTMLElement; start: number; end: number }[] = [];
let audioUrl: string | undefined, audioKey = "", renderedKey = "", trKey = "";

const fmt = (s: number) => { const m = Math.floor(s / 60); return `${String(m).padStart(2, "0")}:${(s - m * 60).toFixed(2).padStart(5, "0")}`; };
const baseUrl = () => (server.value.trim() || DEFAULT_SERVER).replace(/\/+$/, "");

for (const l of LANGS) lang.add(new Option(l, l));
for (const [code, name] of TRANSLATE_LANGS) trLang.add(new Option(name, code));
const settings = chrome.storage.local.get({ server: DEFAULT_SERVER, language: "auto", translate: false, translateTo: "en" }).then((s) => {
  server.value = s.server as string; lang.value = s.language as string;
  trBox.checked = s.translate as boolean; trLang.value = s.translateTo as string; trLang.disabled = !trBox.checked; updateSummary();
});
trBox.addEventListener("change", () => { trLang.disabled = !trBox.checked; chrome.storage.local.set({ translate: trBox.checked }); void maybeTranslate(); });
trLang.addEventListener("change", () => { chrome.storage.local.set({ translateTo: trLang.value }); void maybeTranslate(); });

let lastAsk = "";
async function maybeTranslate() {
  renderTranslation(lastJob);
  if (!needsTranslation(lastJob, trBox.checked, trLang.value)) return;
  const ask = `${lastJob.requestId}:${trLang.value}:${lastJob.tr?.status ?? ""}`;
  if (ask === lastAsk) return;  // one request per state, no loops on persistent errors
  lastAsk = ask;
  const reply = await chrome.runtime.sendMessage({ type: "translate", base: baseUrl(), language: lang.value, translateTo: trLang.value })
    .catch((e) => ({ err: String(e) }));
  if (reply?.build !== BUILD) showError(`Background worker is ${reply?.build ? `build ${reply.build}` : "an older build"}, this page is ${BUILD}: open chrome://extensions and press Reload on Parakeet ASR.`);
}
server.addEventListener("change", () => { chrome.storage.local.set({ server: baseUrl() }); void loadVersions(); });
lang.addEventListener("change", () => chrome.storage.local.set({ language: lang.value }));

// sidePanel.open needs a user gesture, so resolve the window id up front, not inside the click.
let winId: number | undefined;
chrome.windows.getCurrent().then((w) => (winId = w.id));
pinBtn.addEventListener("click", () => {
  if (winId === undefined) return;
  chrome.sidePanel.open({ windowId: winId }).then(() => window.close(), (e) => showError(`Side panel: ${e.message}`));
});

drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); const f = e.dataTransfer?.files[0]; if (f) void start(f); });
drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") fileInput.click(); });
fileInput.addEventListener("change", () => { const f = fileInput.files?.[0]; if (f) void start(f); fileInput.value = ""; });

async function ensurePermission(base: string): Promise<boolean> {
  const origin = new URL(base).origin + "/*";
  if (await chrome.permissions.contains({ origins: [origin] })) return true;
  return chrome.permissions.request({ origins: [origin] });
}

async function start(file: File) {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!(ext in EXT_MIME) && !file.type.startsWith("audio/") && !file.type.startsWith("video/")) { showError(`Unsupported file type: ${file.name}`); return; }
  const mime = file.type || EXT_MIME[ext] || "application/octet-stream";
  const base = baseUrl();
  try { if (!(await ensurePermission(base))) { showError(`Permission to access ${base} was denied.`); return; } }
  catch { showError(`Invalid server URL: ${base}`); return; }
  await putAudio(file, file.name);  // the service worker reads the audio from IndexedDB
  const translateTo = trBox.checked ? trLang.value : undefined;
  // Plain Deepgram request (no translate=): the transcript comes back as fast as ASR allows;
  // the service worker then translates the timed sentences progressively via /v1/translate.
  const url = `${base}/v1/listen?language=${encodeURIComponent(lang.value)}&utterances=true&paragraphs=true`;
  await chrome.storage.session.set({ job: { phase: "running", fileName: file.name, startedAt: Date.now(), translateTo } satisfies JobState });
  const reply = await chrome.runtime.sendMessage({ type: "transcribe", url, mime, base, language: lang.value, translateTo }).catch((e) => ({ err: String(e) }));
  // A service worker left over from an older build still answers, but ignores translateTo.
  if (reply?.build !== BUILD) staleWorker = `Background worker is ${reply?.build ? `build ${reply.build}` : "an older build"}, this page is ${BUILD}` +
    `: open chrome://extensions and press Reload on Parakeet ASR${translateTo ? " (translation will not start until then)" : ""}.`;
  else staleWorker = "";
  if (staleWorker) showError(staleWorker);
}

// Clear: back to the empty drop state (the service worker cancels its loops and wipes storage;
// fall back to wiping it here when an older worker does not know the message).
clearBtn.addEventListener("click", async () => {
  const reply = await chrome.runtime.sendMessage({ type: "clear" }).catch(() => null);
  if (!reply?.ok) { await clearAudio().catch(() => {}); await setState({ phase: "idle" }); }
  lastAsk = ""; staleWorker = "";
  await render({ phase: "idle" });
});

function resetPlayers() {
  for (const el of [audioEl, videoEl]) { el.pause(); el.removeAttribute("src"); el.load(); el.hidden = true; }
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = undefined; audioKey = "";
}

let staleWorker = "";
function showError(msg: string) { errBox.textContent = msg; errBox.hidden = false; }

const isVideo = (blob: Blob, name: string) =>
  blob.type.startsWith("video/") || VIDEO_EXT.has(name.split(".").pop()?.toLowerCase() ?? "");

async function loadPlayer(name: string) {
  if (audioKey === name && audioUrl) return;
  const a = await getAudio();
  if (!a) return;
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = URL.createObjectURL(a.blob); audioKey = a.name;
  const next: HTMLMediaElement = isVideo(a.blob, a.name) ? videoEl : audioEl;
  const other = next === videoEl ? audioEl : videoEl;
  other.pause(); other.removeAttribute("src"); other.load(); other.hidden = true;
  player = next; player.src = audioUrl; player.hidden = false;
}

async function render(job: JobState) {
  clearInterval(timer);
  lastJob = job;
  const running = job.phase === "running";
  const idle = job.phase === "idle";
  // Empty state: just the drop zone + buttons, no player/panes, popup shrinks to content.
  document.body.classList.toggle("empty", idle);
  clearBtn.hidden = idle;
  if (idle) {
    resetPlayers(); out.textContent = ""; trOut.textContent = ""; statusEl.textContent = ""; meta.textContent = "none yet";
    spans = []; trSpans = []; renderedKey = ""; trKey = ""; copyBtn.disabled = dlBtn.disabled = true;
  }
  drop.classList.toggle("busy", running);
  drop.classList.toggle("loaded", job.phase !== "idle");
  errBox.hidden = job.phase !== "error";
  if (job.phase === "error") errBox.textContent = job.error ?? "Unknown error";
  if (job.fileName) { baseName = job.fileName.replace(/\.[^.]+$/, "") || "transcript"; await loadPlayer(job.fileName); if (lastJob !== job) return; }  // a newer state arrived while loading
  if (running) {
    const tick = () => { statusEl.innerHTML = `<span class="spin"></span>${job.note ?? `Transcribing ${job.fileName ?? ""}…`} ${((Date.now() - job.startedAt!) / 1000).toFixed(1)}s`; };
    tick(); timer = setInterval(tick, 100);
    out.textContent = ""; meta.textContent = ""; copyBtn.disabled = dlBtn.disabled = true; renderedKey = "";
    renderTranslation(job);
    return;
  }
  const took = job.startedAt && job.finishedAt ? ` in ${((job.finishedAt - job.startedAt) / 1000).toFixed(1)}s` : "";
  statusEl.textContent = job.phase === "done" ? `Done${took}: ${job.fileName}` : job.phase === "error" ? `Failed${took}` : "";
  if (job.phase !== "done") { renderTranslation(job); return; }
  void maybeTranslate();
  renderTranslation(job);  // progressive: runs on every state update
  const key = `${job.requestId}`;
  if (key === renderedKey) return;
  renderedKey = key;
  meta.textContent = [`Model: ${job.model ?? "unknown"}`, job.duration ? `audio ${job.duration.toFixed(1)}s` : "",
    job.servedBy ? `served by ${job.servedBy}` : "", (job.words?.length ? "" : "no word timings, utterance highlighting")]
    .filter(Boolean).join(" · ");
  renderTranscript(job);
  copyBtn.disabled = dlBtn.disabled = false;
}

function renderTranscript(job: JobState) {
  out.textContent = ""; spans = [];
  const words: Word[] = job.words ?? [], utts = job.utterances ?? [];
  if (words.length) {
    // Group words into utterance paragraphs when available.
    let ui = 0, para: HTMLElement | null = null;
    for (const w of words) {
      while (ui < utts.length && w.start >= utts[ui].end) ui++;
      if (!para || para.dataset.u !== String(ui)) {
        para = document.createElement("div"); para.className = "p"; para.dataset.u = String(ui);
        const t = document.createElement("span"); t.className = "t"; t.textContent = fmt(utts[ui]?.start ?? w.start);
        para.append(t); out.append(para);
      }
      const el = document.createElement("span"); el.className = "w"; el.textContent = w.punctuated_word ?? w.word;
      el.onclick = () => seek(w.start);
      para.append(el, document.createTextNode(" "));
      spans.push({ el, start: w.start, end: w.end });
    }
  } else if (utts.length) {
    for (const u of utts) {
      const d = document.createElement("div"); d.className = "u"; d.onclick = () => seek(u.start);
      const t = document.createElement("span"); t.className = "t"; t.textContent = `[${fmt(u.start)}–${fmt(u.end)}]`;
      d.append(t, document.createTextNode(u.transcript)); out.append(d);
      spans.push({ el: d, start: u.start, end: u.end });
    }
  } else out.textContent = job.transcript || "(empty transcript)";
}

function plainText(job: JobState): string {
  const utts = job.utterances ?? [];
  let t = utts.length ? utts.map((u) => `[${fmt(u.start)} - ${fmt(u.end)}] ${u.transcript}`).join("\n") + "\n" : (job.transcript ?? "") + "\n";
  const tr = job.tr, sents = job.sentences ?? [];
  if (tr && tr.done) t += `\n--- Translation (${tr.target}) ---\n` +
    sents.map((s, i) => tr.items[i] == null ? "" : `[${fmt(s.start)} - ${fmt(s.end)}] ${tr.items[i]}`).filter(Boolean).join("\n") + "\n";
  return t;
}

const trName = (code: string) => TRANSLATE_LANGS.find(([c]) => c === code)?.[1] ?? code;
function trStatusText(tr: TranslationState): string {
  const secs = (((tr.finishedAt ?? Date.now()) - tr.startedAt) / 1000).toFixed(0);
  switch (tr.status) {
    case "warming": return `<span class="spin"></span>Translator warming up (~1 min)${tr.note ? `, ${tr.note}` : ""}… ${tr.done}/${tr.total} sentences`;
    case "translating": return `<span class="spin"></span>Translating to ${trName(tr.target)}: ${tr.done}/${tr.total} sentences`;
    case "done": return `Translated ${tr.total}/${tr.total} sentences to ${trName(tr.target)} in ${secs}s`;
    default: return `Translation stopped at ${tr.done}/${tr.total}: ${tr.error ?? "error"}`;
  }
}

// Second pane: one block per timed source sentence, filled as translations arrive.
function renderTranslation(job: JobState) {
  const tr = job.tr, sents = job.sentences ?? [];
  // The translation pane (and the 800 px width) only when Translate is ticked and there is a transcript (or one coming).
  const wanted = trBox.checked && (job.phase === "running" || job.phase === "done");
  trPane.hidden = !wanted;
  document.body.classList.toggle("wide", wanted);
  if (!wanted) { trKey = ""; trSpans = []; return; }
  if (job.phase === "running" || !tr) {
    trOut.textContent = ""; trSpans = []; trKey = "";
    const target = job.translateTo ?? trLang.value;
    trStatus.textContent = job.phase === "idle" ? `Translation to ${trName(target)} is on: drop a file.`
      : job.phase === "running" ? `Translation to ${trName(target)} starts after the transcript.`
      : job.phase === "done" && Date.now() - (job.finishedAt ?? 0) < 4000 ? "Starting translation…"
      : job.phase === "done" ? `Translation did not start. ${staleWorker || "Reload the extension in chrome://extensions and try again."}`
      : "Translation skipped: transcription failed.";
    trStatus.classList.toggle("err", job.phase !== "running" && job.phase !== "idle" && !trStatus.textContent!.startsWith("Starting"));
    if (job.phase === "done") setTimeout(() => { if (lastJob === job) renderTranslation(job); }, 4500);  // watchdog
    return;
  }
  trStatus.innerHTML = trStatusText(tr);
  trStatus.classList.toggle("err", tr.status === "error");
  const key = `${job.requestId}:${tr.target}`;
  if (key !== trKey) {
    trKey = key; trOut.textContent = ""; trSpans = []; trCur = -1;
    sents.forEach((s) => {
      const d = document.createElement("div"); d.className = "s pending"; d.title = s.text;
      const t = document.createElement("span"); t.className = "t"; t.textContent = fmt(s.start);
      d.append(t, document.createElement("span")); d.onclick = () => seek(s.start);
      trOut.append(d); trSpans.push({ el: d, start: s.start, end: s.end });
    });
  }
  tr.items.forEach((text, i) => {
    const el = trSpans[i]?.el; if (!el || text == null || !el.classList.contains("pending")) return;
    el.classList.remove("pending"); (el.lastChild as HTMLElement).textContent = text;
  });
  if (tr.status !== "done" && tr.status !== "error") trSpans[tr.done]?.el.classList.add("next");
  trSpans.forEach((s, i) => { if (i !== tr.done) s.el.classList.remove("next"); });
}

function seek(t: number) { player.currentTime = t; void player.play(); }

let cur = -1, trCur = -1;
function lastStartingBefore(arr: { start: number }[], t: number): number {
  let i = -1, lo = 0, hi = arr.length - 1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m].start <= t) { i = m; lo = m + 1; } else hi = m - 1; }
  return i;
}
function highlightTranslation(t: number) {
  let i = lastStartingBefore(trSpans, t);
  if (i >= 0 && t > trSpans[i].end + 1.0) i = -1;  // between sentences
  if (i === trCur) return;
  if (trCur >= 0) trSpans[trCur]?.el.classList.remove("cur");
  trCur = i;
  if (i >= 0) { trSpans[i].el.classList.add("cur"); trSpans[i].el.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
}
function highlight() {
  const t = player.currentTime;
  highlightTranslation(t);
  let i = -1;
  // Binary search for the last span starting at or before t.
  let lo = 0, hi = spans.length - 1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (spans[m].start <= t) { i = m; lo = m + 1; } else hi = m - 1; }
  if (i >= 0 && t > spans[i].end + 0.3 && spans[i].el.classList.contains("w")) i = -1;  // in a pause
  if (i === cur) return;
  if (cur >= 0) spans[cur]?.el.classList.remove("cur");
  cur = i;
  if (i >= 0) { spans[i].el.classList.add("cur"); spans[i].el.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
}
for (const el of [audioEl, videoEl]) {
  el.addEventListener("timeupdate", highlight);
  el.addEventListener("seeked", highlight);
  el.addEventListener("play", () => { const loop = () => { highlight(); if (!el.paused) requestAnimationFrame(loop); }; requestAnimationFrame(loop); });
}

copyBtn.addEventListener("click", async () => { await navigator.clipboard.writeText(plainText(lastJob)); copyBtn.textContent = "Copied!"; setTimeout(() => (copyBtn.textContent = "Copy"), 1200); });
dlBtn.addEventListener("click", () => {
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([plainText(lastJob)], { type: "text/plain" }));
  a.download = `${baseName}.txt`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

async function loadVersions() {
  const ext = `Extension ${chrome.runtime.getManifest().version}`;
  versions.textContent = `${ext} · service: loading…`;
  try {
    const r = await fetch(`${baseUrl()}/v1/info`, { signal: AbortSignal.timeout(5000) });
    if (r.status === 404) { versions.textContent = `${ext} · service predates /v1/info (redeploy)`; return; }
    const i = await r.json();
    versions.textContent = `${ext} · Service ${i.service_version} · Model ${i.model} · NeMo ${i.nemo_version} · torch ${i.torch_version}` +
      ` · Pod ${i.pod}${i.gpu ? ` · ${i.gpu}` : ""}` +
      (i.translation ? ` · Mode ${i.translation.mode ?? "?"}` : "");
  } catch { versions.textContent = `${ext} · service unreachable`; }
}

chrome.storage.session.onChanged.addListener((c) => { if (c.job) void render(c.job.newValue as JobState); });
void settings.then(async () => { void loadVersions(); await render(await getState()); });
