declare const __BUILD__: string;
/** Extension build (manifest version), compiled into both the page and the service worker. */
export const BUILD: string = typeof __BUILD__ === "string" ? __BUILD__ : "dev";
export const DEFAULT_SERVER = "http://192.168.8.226:30800";
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
export function summaryText(language: string, translate: boolean, target: string): string {
  return translate ? `${language} → ${target}` : language;
}
