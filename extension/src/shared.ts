export const DEFAULT_SERVER = "http://192.168.8.226:30800";
export const LANGS = ["auto","bg","cs","da","de","el","en","es","et","fi","fr","hr","hu","it","lt","lv","mt","nl","pl","pt","ro","ru","sk","sl","sv","uk"];

export interface Word { word: string; start: number; end: number; punctuated_word?: string }
export interface Utterance { start: number; end: number; transcript: string }
export interface JobState {
  phase: "idle" | "running" | "done" | "error";
  fileName?: string;
  startedAt?: number;
  finishedAt?: number;
  transcript?: string;
  words?: Word[];
  utterances?: Utterance[];
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

export const getState = async (): Promise<JobState> =>
  ((await chrome.storage.session.get("job")).job as JobState) ?? { phase: "idle" };
export const setState = (job: JobState) => chrome.storage.session.set({ job });
