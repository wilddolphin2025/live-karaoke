// Runs uploads so they survive the popup closing (it closes whenever it loses focus).
// Flow: POST /v1/listen?paragraphs=true (plain Deepgram, fast) -> show transcript -> then
// POST /v1/translate one timed sentence at a time, publishing each translation as it lands.
import { BUILD, getAudio, setState, JobState, Sentence, TranslationState } from "./shared";

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === "transcribe") {
    void run(msg.url as string, msg.mime as string, msg.base as string, msg.language as string, msg.translateTo as string | undefined);
    reply({ ok: true, build: BUILD });
  } else if (msg?.type === "translate") {
    // Translate the finished transcript (Translate ticked, or target changed, after the file was dropped).
    void retranslate(msg.base as string, msg.language as string, msg.translateTo as string);
    reply({ ok: true, build: BUILD });
  }
  return false;
});

// Keep the worker alive during long jobs (MV3 idles out after ~30s without events).
let keepAlive: ReturnType<typeof setInterval> | undefined;
let generation = 0;  // a newer job cancels an older translation loop

// The first translate call switches the cluster to translate mode (1 ASR pod + translator, ~1 min):
// 503 + Retry-After until it is up. Retry for up to ~8 minutes.
const WARMING = new Set(["TRANSLATOR_WARMING_UP", "TRANSLATOR_UNAVAILABLE"]);
const MAX_WARM_TRIES = 32;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readJson(r: Response): Promise<{ text: string; data: any }> {
  const text = await r.text();
  let data: any = null; try { data = JSON.parse(text); } catch { /* non-JSON */ }
  return { text, data };
}

async function run(url: string, mime: string, base: string, language: string, translateTo?: string) {
  const audio = await getAudio();
  if (!audio) return;
  const gen = ++generation;
  const job: JobState = { phase: "running", fileName: audio.name, startedAt: Date.now(), translateTo };
  await setState(job);
  clearInterval(keepAlive);
  keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000);
  try {
    let r: Response;
    try { r = await fetch(url, { method: "POST", headers: { "Content-Type": mime }, body: audio.blob }); }
    catch (e) {
      await setState({ ...job, phase: "error", finishedAt: Date.now(),
        error: `Network error: could not reach the server (${(e as Error).message}). Check the URL and that the service is up; for https://slim accept the certificate first.` });
      return;
    }
    const { text, data } = await readJson(r);
    const servedBy = r.headers.get("x-served-by") ?? undefined;
    const finishedAt = Date.now();
    if (!r.ok) {
      const hint = r.status === 503 ? " (server busy, try again shortly)" : r.status === 504 ? " (server timed out)" : "";
      await setState({ ...job, phase: "error", finishedAt, servedBy, requestId: data?.request_id,
        error: `Error ${r.status}${hint}: ${data?.err_msg ?? (text.slice(0, 300) || "unknown error")}` +
          (data?.err_code ? `\nCode: ${data.err_code}` : "") + (data?.request_id ? `\nRequest ID: ${data.request_id}` : "") });
      return;
    }
    const alt = data?.results?.channels?.[0]?.alternatives?.[0] ?? {};
    const models = data?.metadata?.models;
    const utterances = data?.results?.utterances ?? [];
    // Timed sentences: Deepgram paragraphs if the server has them, else utterances (older servers).
    let sentences: Sentence[] = (alt.paragraphs?.paragraphs ?? []).flatMap((p: any) => p.sentences ?? []);
    if (!sentences.length) sentences = utterances.map((u: any) => ({ text: u.transcript, start: u.start, end: u.end }));
    sentences = sentences.filter((s) => s.text?.trim());
    const done: JobState = { ...job, phase: "done", finishedAt, servedBy,
      transcript: alt.transcript ?? "", words: alt.words ?? [], utterances, sentences,
      model: Array.isArray(models) ? models.join(", ") : models, duration: data?.metadata?.duration,
      requestId: data?.metadata?.request_id };
    await setState(done);  // transcript shows now; translation fills in below
    if (translateTo) {
      if (sentences.length) await translateAll(done, base, language, translateTo, gen);
      else await setState({ ...done, tr: { target: translateTo, status: "error", done: 0, total: 0, items: [], startedAt: Date.now(),
        finishedAt: Date.now(), error: "no sentences in the transcript to translate" } });
    }
  } catch (e) {
    await setState({ ...job, phase: "error", finishedAt: Date.now(), error: `Extension error: ${(e as Error).message}` });
  } finally { if (gen === generation) clearInterval(keepAlive); }
}

async function retranslate(base: string, language: string, target: string) {
  const job = (await chrome.storage.session.get("job")).job as JobState | undefined;
  if (!job || job.phase !== "done") return;
  const gen = ++generation;
  const withTarget: JobState = { ...job, translateTo: target, tr: undefined };
  clearInterval(keepAlive);
  keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000);
  try {
    if (job.sentences?.length) await translateAll(withTarget, base, language, target, gen);
    else await setState({ ...withTarget, tr: { target, status: "error", done: 0, total: 0, items: [], startedAt: Date.now(),
      finishedAt: Date.now(), error: "no sentences in the transcript to translate" } });
  } catch (e) {
    await setState({ ...withTarget, tr: { target, status: "error", done: 0, total: 0, items: [], startedAt: Date.now(),
      finishedAt: Date.now(), error: `Extension error: ${(e as Error).message}` } });
  } finally { if (gen === generation) clearInterval(keepAlive); }
}

async function translateAll(job: JobState, base: string, language: string, target: string, gen: number) {
  const sentences = job.sentences!;
  const tr: TranslationState = { target, status: "warming", done: 0, total: sentences.length,
    items: sentences.map(() => null), startedAt: Date.now() };
  const publish = async () => { if (gen === generation) await setState({ ...job, tr: { ...tr, items: [...tr.items] } }); };
  const post = async (batch: Sentence[]): Promise<any> => {
    for (let attempt = 1; ; attempt++) {
      if (gen !== generation) return null;
      let r: Response;
      try {
        r = await fetch(`${base}/v1/translate`, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target, source: language, sentences: batch }) });
      } catch (e) {
        if (attempt >= 4) throw new Error(`could not reach the server (${(e as Error).message})`);
        await sleep(3000); continue;  // e.g. the pod we hit was just scaled away
      }
      const { text, data } = await readJson(r);
      if (r.ok) return data;
      if (r.status === 404) throw new Error("server predates /v1/translate (redeploy the service to 0.5.0)");
      if (r.status === 503 && attempt < MAX_WARM_TRIES) {
        const wait = Math.min(60, Math.max(3, Number(r.headers.get("retry-after")) || 15));
        if (WARMING.has(data?.err_code)) { tr.status = "warming"; tr.note = `retry ${attempt} in ${wait}s`; await publish(); }
        await sleep(wait * 1000); continue;
      }
      throw new Error(`Error ${r.status}: ${data?.err_msg ?? text.slice(0, 200)}`);
    }
  };
  try {
    await publish();
    if ((await post([])) === null) return;         // warm-up / mode switch, no work yet
    tr.status = "translating"; tr.note = undefined; await publish();
    for (let i = 0; i < sentences.length; i++) {
      const s = sentences[i];
      const data = await post([{ text: s.text, start: s.start, end: s.end }]);
      if (data === null) return;
      tr.items[i] = data?.sentences?.[0]?.translation ?? "";
      tr.done = i + 1; tr.model = data?.model;
      await publish();
    }
    tr.status = "done"; tr.finishedAt = Date.now(); await publish();
  } catch (e) {
    tr.status = "error"; tr.error = (e as Error).message; tr.finishedAt = Date.now(); await publish();
  }
}
