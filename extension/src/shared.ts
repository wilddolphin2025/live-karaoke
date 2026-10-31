declare const __BUILD__: string;
/** Extension build (manifest version), compiled into both the page and the service worker. */
export const BUILD: string = typeof __BUILD__ === "string" ? __BUILD__ : "dev";
declare const __DEFAULT_SERVER__: string;
// Empty unless the build sets LK_SERVER (extension/local.env): first run then opens Settings.
export const DEFAULT_SERVER: string = typeof __DEFAULT_SERVER__ === "string" ? __DEFAULT_SERVER__ : "";
// ---- Server access (0.7.0): optional Bearer token for a protected public edge, and base URLs with a path
// prefix (e.g. https://edge.example/karaoke). Never `new URL("/v1/..", base)`: that drops the prefix.
export const AUTH_MSG = "Access token missing or invalid — check Settings";
export const isAuthError = (status: number) => status === 401 || status === 403;
/** base (with or without a trailing slash, may include a path) + "v1/..." -> base/v1/... */
export function apiUrl(base: string, path: string): string {
  return `${base.trim().replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
/** A server-returned link (absolute, or root-relative to the API like "/v1/jobs/x/download") under the base. */
export function resolveServerUrl(base: string, link: string): string {
  return /^https?:\/\//i.test(link) ? link : apiUrl(base, link);
}
export function authHeaders(token: string | undefined, h: Record<string, string> = {}): Record<string, string> {
  const t = (token ?? "").trim();
  return t ? { ...h, Authorization: `Bearer ${t}` } : { ...h };
}
export const getToken = async (): Promise<string> => ((await chrome.storage.local.get({ token: "" })).token as string) ?? "";
/** fetch() to the Live Karaoke server: adds the Bearer token (if set). Use for every server request. */
export async function apiFetch(url: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<Response> {
  return fetch(url, { ...init, headers: authHeaders(await getToken(), init.headers) });
}
/** Download server media with the token into an object URL (media elements can't send headers). */
export async function fetchMediaUrl(url: string): Promise<string> {
  const r = await apiFetch(url);
  if (isAuthError(r.status)) throw new Error(AUTH_MSG);
  if (!r.ok) throw new Error(`Error ${r.status} downloading the file`);
  return URL.createObjectURL(await r.blob());
}

export const LANGS = ["auto","bg","cs","da","de","el","en","es","et","fi","fr","hr","hu","it","lt","lv","mt","nl","pl","pt","ro","ru","sk","sl","sv","uk"];

// Target languages offered in the UI: the 55 that google/translategemma-4b-it was evaluated on (WMT24++);
// the server accepts any code of its template (sent as ?translate=<code>, Deepgram's name).
export const TRANSLATE_LANGS: [string, string][] = [["en","English"],["ar","Arabic"],["bn","Bengali"],["bg","Bulgarian"],["ca","Catalan"],["zh","Chinese (Simplified)"],["zh-tw","Chinese (Traditional)"],["hr","Croatian"],["cs","Czech"],["da","Danish"],["nl","Dutch"],["et","Estonian"],["fi","Finnish"],["fr","French"],["de","German"],["el","Greek"],["gu","Gujarati"],["he","Hebrew"],["hi","Hindi"],["hu","Hungarian"],["is","Icelandic"],["id","Indonesian"],["it","Italian"],["ja","Japanese"],["kn","Kannada"],["ko","Korean"],["lv","Latvian"],["lt","Lithuanian"],["ml","Malayalam"],["mr","Marathi"],["no","Norwegian"],["fa","Persian"],["pl","Polish"],["pt","Portuguese"],["pt-br","Portuguese (Brazil)"],["pt-pt","Portuguese (Portugal)"],["pa","Punjabi"],["ro","Romanian"],["ru","Russian"],["sr","Serbian"],["sk","Slovak"],["sl","Slovenian"],["es","Spanish"],["sw","Swahili"],["sv","Swedish"],["tl","Tagalog"],["ta","Tamil"],["te","Telugu"],["th","Thai"],["tr","Turkish"],["uk","Ukrainian"],["ur","Urdu"],["vi","Vietnamese"],["zu","Zulu"]];
export interface Translation { language: string; translation: string }
export interface Word { word: string; start: number; end: number; punctuated_word?: string }
export interface Utterance { start: number; end: number; transcript: string; translations?: Translation[] }
export interface Sentence { text: string; start: number; end: number }
export interface TranslationState {
  target: string;
  status: "warming" | "translating" | "done" | "error";
  done: number;
  total: number;
  items: (string | null)[];  // one per JobState.sentences entry, null until translated
  startedAt: number;
  finishedAt?: number;
  note?: string;
  model?: string;
  error?: string;
}
export interface JobState {
  phase: "idle" | "running" | "done" | "error";
  fileName?: string;
  startedAt?: number;
  finishedAt?: number;
  transcript?: string;
  translations?: Translation[];
  translateTo?: string;
  note?: string;          // e.g. translator warming up, retry n
  words?: Word[];
  utterances?: Utterance[];
  detectedLanguage?: string;  // server's guess when language=auto (Deepgram detected_language)
  sentences?: Sentence[];   // timed source sentences (Deepgram paragraphs)
  tr?: TranslationState;    // progressive translation of `sentences`
  model?: string;
  duration?: number;
  servedBy?: string;
  requestId?: string;
  error?: string;
  separate?: boolean;       // "Remove vocals" was on at drop: the worker starts it after transcript/translation
  sep?: SeparationState;    // vocal-removal job (only ever when requested)
}

// IndexedDB holds the audio blob so the popup can restore its player after closing.
const DB = "parakeet", STORE = "audio";
function db(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
export async function putAudio(blob: Blob, name: string): Promise<void> {
  const d = await db();
  await new Promise<void>((res, rej) => {
    const tx = d.transaction(STORE, "readwrite"); tx.objectStore(STORE).put({ blob, name }, "last");
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
}
export async function getAudio(): Promise<{ blob: Blob; name: string } | undefined> {
  const d = await db();
  return new Promise((res, rej) => {
    const r = d.transaction(STORE).objectStore(STORE).get("last");
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}

export async function clearAudio(): Promise<void> {
  const d = await db();
  await new Promise<void>((res, rej) => {
    const tx = d.transaction(STORE, "readwrite"); tx.objectStore(STORE).delete("last");
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
}
export const getState = async (): Promise<JobState> =>
  ((await chrome.storage.session.get("job")).job as JobState) ?? { phase: "idle" };
export const setState = (job: JobState) => chrome.storage.session.set({ job });

// Root cause of "no translation" (0.5.1): translation was decided only at drop time, so ticking Translate
// after the transcript (or reopening the popup with it ticked) did nothing. Now a finished transcript is
// translated whenever Translate is on and it has no translation to the selected language yet.
export function needsTranslation(job: JobState, checked: boolean, target: string): boolean {
  if (!checked || job.phase !== "done") return false;
  if (!job.tr) return true;
  return job.tr.target !== target || job.tr.status === "error" && !!job.sentences?.length;
}

/** Compact settings chip for the main view, e.g. "auto → en" or "es". */
export function summaryText(language: string, translate: boolean, target: string, separate = false): string {
  return (translate ? `${language} → ${target}` : language) + (separate ? " · no vocals" : "");
}

// ---- Vocal removal (0.6.0): strictly on demand. Only when "Remove vocals" is ticked does the extension
// POST /v1/separate, and only after the transcript (and translation, if any) are delivered.
export interface SeparationState {
  jobId?: string;
  base: string;            // server the job lives on (for polling, download and DELETE on Clear)
  status: "starting" | "queued" | "separating" | "transcribing" | "muxing" | "done" | "error";
  progress: number;        // 0..1
  stage?: string;
  device?: string;
  model?: string;
  downloadUrl?: string;    // absolute
  isVideo?: boolean;
  size?: number;
  words?: Word[];          // vocals-stem transcript, for highlighting while the instrumental plays
  utterances?: Utterance[];
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

/** Should the page ask the worker to start vocal removal now? Never unless ticked; never twice;
 *  not before the transcript is done; not while a translation for this job is still running;
 *  not when the drop itself requested it (the worker then starts it on its own). */
export function needsSeparation(job: JobState, checked: boolean): boolean {
  if (!checked || job.phase !== "done" || job.sep || job.separate) return false;
  if (job.translateTo && (!job.tr || (job.tr.status !== "done" && job.tr.status !== "error"))) return false;
  return true;
}

/** Status line for the vocal-removal row. */
export function sepStatusText(s: SeparationState): string {
  const pct = `${Math.round((s.progress || 0) * 100)}%`;
  const dev = s.device ? ` on ${s.device.toUpperCase()}` : "";
  switch (s.status) {
    case "starting": return "Removing vocals: uploading…";
    case "queued": return `Removing vocals: ${s.stage && s.stage !== "queued" ? s.stage : "queued"}…`;
    case "separating": return `Removing vocals${dev}: ${pct}${s.stage?.startsWith("starting") ? " (starting separator)" : ""}`;
    case "transcribing": return `Removing vocals: transcribing the singer… ${pct}`;
    case "muxing": return `Removing vocals: writing the file… ${pct}`;
    case "done": {
      const secs = s.finishedAt ? ` in ${((s.finishedAt - s.startedAt) / 1000).toFixed(0)}s` : "";
      return `Instrumental ready${secs}${s.model ? ` (${s.model}${dev})` : ""}`;
    }
    default: return `Vocal removal failed: ${s.error ?? "error"}`;
  }
}

/** Map a GET /v1/jobs/{id} body onto the extension's state. */
export function applyJob(s: SeparationState, j: any): SeparationState {
  const st = j?.status;
  const status: SeparationState["status"] = st === "failed" || st === "cancelled" ? "error"
    : ["queued", "separating", "transcribing", "muxing", "done"].includes(st) ? st : s.status;
  const next: SeparationState = { ...s, status, progress: Number(j?.progress ?? s.progress) || 0, stage: j?.stage ?? s.stage,
    device: j?.device ?? s.device, model: j?.model ?? s.model, isVideo: j?.is_video ?? s.isVideo, size: j?.size ?? s.size };
  if (j?.download_url) next.downloadUrl = resolveServerUrl(s.base, j.download_url);
  if (status === "error") next.error = j?.error?.err_msg ?? "failed";
  if (status === "done") { next.words = j?.result?.words ?? []; next.utterances = j?.result?.utterances ?? []; next.progress = 1; }
  return next;
}

/** Karaoke: highlight this far ahead of the sung word so the singer sees it coming. */
export const KARAOKE_LEAD_S = 0.25;
/** Index of the word to highlight at playback time t (spans sorted by start), or -1 in a pause.
 *  With a lead the highlight moves to a word lead seconds before it starts. */
export function wordAt(spans: { start: number; end: number }[], t: number, lead = 0, pause = 0.3): number {
  const x = t + lead;
  let i = -1, lo = 0, hi = spans.length - 1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (spans[m].start <= x) { i = m; lo = m + 1; } else hi = m - 1; }
  if (i >= 0 && t > spans[i].end + pause) i = -1;
  return i;
}

/** What toggling "Remove vocals" does right now (0.6.2):
 *  off: a running job is cancelled (DELETE) and the player goes back to the original; a finished job is kept
 *       (hidden, deleted by the server TTL or ✕) so turning it on again swaps back instantly.
 *  on:  a finished job -> karaoke media; a running one -> keep waiting; none (or failed) -> start one for this file. */
export type SepToggle = "none" | "original" | "cancel" | "karaoke" | "start" | "wait";
export function sepToggleAction(checked: boolean, job: JobState): SepToggle {
  if (job.phase !== "done") return "none";
  const s = job.sep, busy = !!s && s.status !== "done" && s.status !== "error";
  if (!checked) return busy || (!s && job.separate) ? "cancel" : "original";
  if (s?.status === "done") return "karaoke";
  if (busy || (!s && job.separate)) return "wait";
  return "start";
}
