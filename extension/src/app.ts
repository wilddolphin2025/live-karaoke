import { AUTH_MSG, BUILD, apiFetch, apiUrl, fetchMediaUrl, isAuthError, needsTranslation, needsSeparation, sepStatusText, sepToggleAction, wordAt, KARAOKE_LEAD_S, summaryText, DEFAULT_SERVER, LANGS, TRANSLATE_LANGS, JobState, Word, TranslationState, clearAudio, getAudio, getState, putAudio, setState } from "./shared";

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
  summary.textContent = summaryText(lang.value, trBox.checked, trLang.value, sepBox?.checked ?? false);
}
const token = $<HTMLInputElement>("token"), tokenClear = $<HTMLButtonElement>("tokenclear");
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
const sepBox = $<HTMLInputElement>("sep"), sepBar = $<HTMLDivElement>("sepbar"), sepStatus = $<HTMLDivElement>("sepstatus");
const sepMode = $<HTMLButtonElement>("sepmode"), sepDl = $<HTMLAnchorElement>("sepdl");
let mode: "orig" | "inst" = "orig", modeJob = "";  // which track the player plays (instrumental only after vocal removal)
const baseUrl = () => (server.value.trim() || DEFAULT_SERVER).replace(/\/+$/, "");

for (const l of LANGS) lang.add(new Option(l, l));
for (const [code, name] of TRANSLATE_LANGS) trLang.add(new Option(name, code));
const settings = chrome.storage.local.get({ token: "", server: DEFAULT_SERVER, language: "auto", translate: false, translateTo: "en", separate: false }).then((s) => {
  server.value = s.server as string; token.value = s.token as string; tokenClear.hidden = !token.value; lang.value = s.language as string;
  if (!server.value.trim()) showSettings(true);   // first run: no server configured yet
  trBox.checked = s.translate as boolean; trLang.value = s.translateTo as string; trLang.disabled = !trBox.checked; sepBox.checked = s.separate === true; updateSummary();
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
  if (reply?.build !== BUILD) showError(`Background worker is ${reply?.build ? `build ${reply.build}` : "an older build"}, this page is ${BUILD}: open chrome://extensions and press Reload on Live Karaoke.`);
}
const saveToken = () => { token.value = token.value.trim(); tokenClear.hidden = !token.value; chrome.storage.local.set({ token: token.value }); void loadVersions(); };
token.addEventListener("change", saveToken);
token.addEventListener("paste", () => setTimeout(saveToken, 0));
tokenClear.addEventListener("click", () => { token.value = ""; saveToken(); });
server.addEventListener("change", () => { chrome.storage.local.set({ server: baseUrl() }); void loadVersions(); });
lang.addEventListener("change", () => chrome.storage.local.set({ language: lang.value }));
// "Remove vocals": strictly opt-in. Ticking it after a transcript removes the vocals of that file.
// Toggling takes effect immediately on the loaded file (0.6.2).
sepBox.addEventListener("change", async () => {
  chrome.storage.local.set({ separate: sepBox.checked }); updateSummary();
  const act = sepToggleAction(sepBox.checked, lastJob);
  if (act === "cancel") {   // running job: stop polling + DELETE on the server; the worker drops sep from the state
    await chrome.runtime.sendMessage({ type: "cancelSeparate" }).catch(() => null);
    lastSepAsk = "";
  }
  if (act === "cancel" || act === "original") await switchTo("orig");
  if (act === "karaoke") { autoSwitched = lastJob.sep?.jobId ?? ""; await switchTo("inst"); }
  if (act === "start") { lastSepAsk = ""; if (lastJob.sep?.status === "error") await chrome.runtime.sendMessage({ type: "cancelSeparate" }).catch(() => null);
    else void maybeSeparate(); }
  renderSep(lastJob);
});
let lastSepAsk = "";
async function maybeSeparate() {
  if (!needsSeparation(lastJob, sepBox.checked)) return;
  const ask = `${lastJob.requestId}`;
  if (ask === lastSepAsk) return;
  lastSepAsk = ask;
  await chrome.runtime.sendMessage({ type: "separate", base: baseUrl(), language: lang.value }).catch(() => null);
}
function renderSep(job: JobState) {
  const s = job.sep;
  const pending = !s && sepBox.checked && (job.phase === "running" || (job.phase === "done" && job.separate === true));
  sepBar.hidden = (!s && !pending) || (!!s && !sepBox.checked);  // unticked: karaoke controls hidden
  if (!s) { sepMode.hidden = sepDl.hidden = true; if (pending) sepStatus.textContent = "Vocals will be removed after the transcript" + (job.translateTo ? " and translation." : "."); return; }
  const busy = s.status !== "done" && s.status !== "error";
  sepStatus.innerHTML = (busy ? '<span class="spin"></span>' : "") + escapeHtml(sepStatusText(s));
  sepStatus.title = s.error ?? "";
  const ready = s.status === "done" && !!s.downloadUrl;
  sepDl.hidden = !ready;
  if (ready) { sepDl.href = instUrl && instFor === s.downloadUrl ? instUrl : "#"; sepDl.download = `${baseName}-instrumental.${s.isVideo ? "mp4" : "mp3"}`; sepDl.title = `Download the ${s.isVideo ? "video without the lead voice" : "instrumental"}`; }
  sepMode.hidden = !ready || !player || player.hidden;
  // Karaoke: when the job finishes, the instrumental/karaoke video replaces the media in the player.
  if (ready && sepBox.checked && player && !player.hidden && audioUrl && autoSwitched !== s.jobId) { autoSwitched = s.jobId!; void switchTo("inst"); }
  sepMode.textContent = mode === "inst" ? "🎤 Original" : "🎶 Instrumental";
}
const escapeHtml = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
// Swap the player's media in place, keeping position and play/pause state.
async function switchTo(m: "orig" | "inst") {
  const s = lastJob.sep;
  if (!player || m === mode || (m === "inst" && !s?.downloadUrl)) return;
  // The original is kept as a blob URL of the IndexedDB copy; recreate it if it was revoked/lost.
  if (m === "orig" && !audioUrl) { const a = await getAudio(); if (!a) return; audioUrl = URL.createObjectURL(a.blob); audioKey = a.name; }
  let src = audioUrl!;
  if (m === "inst") { try { src = await instMedia(s!.downloadUrl!); } catch (e) { showError((e as Error).message); return; } }
  const t = player.currentTime, playing = !player.paused;
  mode = m;
  player.src = src;
  player.addEventListener("loadedmetadata", () => { player!.currentTime = t; if (playing) void player!.play(); }, { once: true });
  document.body.classList.toggle("karaoke", mode === "inst");
  renderedKey = ""; cur = -1; curLine = null; renderTranscript(lastJob); renderSep(lastJob);
}
// Instrumental/karaoke media is fetched with the access token into a blob URL (no token in URLs).
let instUrl: string | undefined, instFor = "";
async function instMedia(url: string): Promise<string> {
  if (instUrl && instFor === url) return instUrl;
  const u = await fetchMediaUrl(url);
  if (instUrl) URL.revokeObjectURL(instUrl);
  instUrl = u; instFor = url; renderSep(lastJob);
  return u;
}
sepDl.addEventListener("click", async (e) => {
  const url = lastJob.sep?.downloadUrl;
  if (!url || (instUrl && instFor === url)) return;   // already a blob URL: the browser downloads it
  e.preventDefault();
  try { const u = await instMedia(url); const a = document.createElement("a"); a.href = u; a.download = sepDl.download; a.click(); }
  catch (err) { showError((err as Error).message); }
});
let autoSwitched = "";  // sep job id the player was switched to automatically (once; Original stays a manual choice)
sepMode.addEventListener("click", () => void switchTo(mode === "inst" ? "orig" : "inst"));

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
  const separate = sepBox.checked;  // vocal removal only when the user opted in
  // Plain Deepgram request (no translate=): the transcript comes back as fast as ASR allows;
  // the service worker then translates the timed sentences progressively via /v1/translate.
  const url = apiUrl(base, `v1/listen?language=${encodeURIComponent(lang.value)}&utterances=true&paragraphs=true`);
  await chrome.storage.session.set({ job: { phase: "running", fileName: file.name, startedAt: Date.now(), translateTo, ...(separate ? { separate } : {}) } satisfies JobState });
  const reply = await chrome.runtime.sendMessage({ type: "transcribe", url, mime, base, language: lang.value, translateTo, separate }).catch((e) => ({ err: String(e) }));
  // A service worker left over from an older build still answers, but ignores translateTo.
  if (reply?.build !== BUILD) staleWorker = `Background worker is ${reply?.build ? `build ${reply.build}` : "an older build"}, this page is ${BUILD}` +
    `: open chrome://extensions and press Reload on Live Karaoke${translateTo ? " (translation will not start until then)" : ""}.`;
  else staleWorker = "";
  if (staleWorker) showError(staleWorker);
}

// Clear: back to the empty drop state (the service worker cancels its loops and wipes storage;
// fall back to wiping it here when an older worker does not know the message).
clearBtn.addEventListener("click", async () => {
  const reply = await chrome.runtime.sendMessage({ type: "clear" }).catch(() => null);
  if (!reply?.ok) { await clearAudio().catch(() => {}); await setState({ phase: "idle" }); }
  lastAsk = ""; lastSepAsk = ""; autoSwitched = ""; staleWorker = "";
  await render({ phase: "idle" });
});

function resetPlayers() {
  for (const el of [audioEl, videoEl]) { el.pause(); el.removeAttribute("src"); el.load(); el.hidden = true; }
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = undefined; audioKey = "";
  if (instUrl) URL.revokeObjectURL(instUrl);
  instUrl = undefined; instFor = "";
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
    spans = []; trSpans = []; renderedKey = ""; trKey = ""; renderSep(job); copyBtn.disabled = dlBtn.disabled = true;
  }
  drop.classList.toggle("busy", running);
  drop.classList.toggle("loaded", job.phase !== "idle");
  const jobKey = `${job.fileName ?? ""}:${job.startedAt ?? ""}`;
  if (jobKey !== modeJob) { mode = "orig"; modeJob = jobKey; document.body.classList.remove("karaoke"); }  // new file
  else if (mode === "inst" && job.sep?.status !== "done") void switchTo("orig");  // job gone: original, same position
  errBox.hidden = job.phase !== "error";
  if (job.phase === "error") errBox.textContent = job.error ?? "Unknown error";
  if (job.fileName) { baseName = job.fileName.replace(/\.[^.]+$/, "") || "transcript"; await loadPlayer(job.fileName); if (lastJob !== job) return; }  // a newer state arrived while loading
  renderSep(job);
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
  void maybeSeparate();
  renderTranslation(job);  // progressive: runs on every state update
  const key = `${job.requestId}:${mode}`;
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
  // While the instrumental plays, highlight from the vocals-stem transcript (the words the removed singer sang).
  const src = mode === "inst" && job.sep?.status === "done" ? job.sep : job;
  const words: Word[] = src.words ?? [], utts = src.utterances ?? [];
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
let curLine: HTMLElement | null = null;
function highlight() {
  const t = player.currentTime;
  highlightTranslation(t);
  const karaoke = mode === "inst";
  // Karaoke: highlight a little ahead of the sung word, keep the current line marked and centred.
  let i = wordAt(spans, t, karaoke ? KARAOKE_LEAD_S : 0, 0.3);
  if (i >= 0 && !spans[i].el.classList.contains("w")) i = wordAt(spans, t, karaoke ? KARAOKE_LEAD_S : 0, Infinity);  // utterances: no pause gaps
  if (karaoke) {
    const line = (i >= 0 ? spans[i] : spans[wordAt(spans, t, KARAOKE_LEAD_S, Infinity)])?.el.closest<HTMLElement>(".p, .u") ?? null;
    if (line !== curLine) {
      curLine?.classList.remove("line"); curLine = line;
      if (line) { line.classList.add("line"); line.scrollIntoView({ block: "center", behavior: "smooth" }); }
    }
  }
  if (i === cur) return;
  if (cur >= 0) spans[cur]?.el.classList.remove("cur");
  cur = i;
  if (i >= 0) { spans[i].el.classList.add("cur"); if (!karaoke) spans[i].el.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
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
    const r = await apiFetch(apiUrl(baseUrl(), "v1/info"), { signal: AbortSignal.timeout(5000) });
    if (isAuthError(r.status)) { versions.textContent = `${ext} · ${AUTH_MSG}`; return; }
    if (r.status === 404) { versions.textContent = `${ext} · service predates /v1/info (redeploy)`; return; }
    const i = await r.json();
    versions.textContent = `${ext} · Service ${i.service_version} · Model ${i.model} · NeMo ${i.nemo_version} · torch ${i.torch_version}` +
      ` · Pod ${i.pod}${i.gpu ? ` · ${i.gpu}` : ""}` +
      (i.translation ? ` · Mode ${i.translation.mode ?? "?"}` : "");
  } catch { versions.textContent = `${ext} · service unreachable`; }
}

chrome.storage.session.onChanged.addListener((c) => { if (c.job) void render(c.job.newValue as JobState); });
void settings.then(async () => { void loadVersions(); await render(await getState()); });
