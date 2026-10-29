// Runs uploads so they survive the popup closing (it closes whenever it loses focus).
// Flow: POST /v1/listen?paragraphs=true (plain Deepgram, fast) -> show transcript -> then
// POST /v1/translate one timed sentence at a time, publishing each translation as it lands ->
// only if "Remove vocals" is on: POST /v1/separate and poll the job (0.6.0).
import { BUILD, LANGS, applyJob, clearAudio, getAudio, getState, setState, JobState, SeparationState, Sentence, TranslationState } from "./shared";

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === "transcribe") {
    void run(msg.url as string, msg.mime as string, msg.base as string, msg.language as string, msg.translateTo as string | undefined,
      msg.separate === true);
    reply({ ok: true, build: BUILD });
  } else if (msg?.type === "translate") {
    // Translate the finished transcript (Translate ticked, or target changed, after the file was dropped).
    void retranslate(msg.base as string, msg.language as string, msg.translateTo as string);
    reply({ ok: true, build: BUILD });
  }
  else if (msg?.type === "cancelSeparate") {
    // "Remove vocals" unticked while running (or a failed job before a retry): stop polling, delete the server job,
    // drop it from the state. The transcript, translation and original audio stay.
    sepGen++;
    void getState().then(async (j) => {
      const s = j.sep;
      if (s?.jobId) await fetch(`${s.base}/v1/jobs/${s.jobId}`, { method: "DELETE" }).catch(() => {});
      const { sep: _drop, separate: _s, ...rest } = j;
      await setState(rest);
    }).then(() => reply({ ok: true, build: BUILD }));
    return true;
  }
  else if (msg?.type === "separate") {
    // "Remove vocals" ticked after the transcript (or the drop predates the tick): start it now.
    void separate(msg.language as string);
    reply({ ok: true, build: BUILD });
  }
  else if (msg?.type === "clear") {
    // Clear button: cancel any running upload/translation/separation loop, delete the server job,
    // drop the stored audio and job.
    generation++; sepGen++; clearInterval(keepAlive);
    void getState().then((j) => { const s = j.sep; if (s?.jobId) return fetch(`${s.base}/v1/jobs/${s.jobId}`, { method: "DELETE" }).then(() => {}); })
      .catch(() => {})
      .then(() => clearAudio()).catch(() => {}).then(() => setState({ phase: "idle" })).then(() => reply({ ok: true, build: BUILD }));
    return true;
  }
  return false;
});

// Keep the worker alive during long jobs (MV3 idles out after ~30s without events).
let keepAlive: ReturnType<typeof setInterval> | undefined;
let generation = 0;  // a newer job cancels an older translation loop
let sepGen = 0;      // a newer job or Clear cancels vocal-removal polling

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

async function run(url: string, mime: string, base: string, language: string, translateTo?: string, separateVocals = false) {
  const audio = await getAudio();
  if (!audio) return;
  const gen = ++generation;
  sepGen++;  // a previous file's vocal-removal polling stops
  const job: JobState = { phase: "running", fileName: audio.name, startedAt: Date.now(), translateTo,
    ...(separateVocals ? { separate: true } : {}) };
  await setState(job);
  clearInterval(keepAlive);
  keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000);
  try {
    let r: Response;
    try { r = await fetch(url, { method: "POST", headers: { "Content-Type": mime }, body: audio.blob }); }
    catch (e) {
      await setState({ ...job, phase: "error", finishedAt: Date.now(),
        error: `Network error: could not reach the server (${(e as Error).message}). Check the URL and that the service is up; for an https server with a self-signed cert, open it in a tab and accept the certificate first.` });
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
      detectedLanguage: data?.results?.channels?.[0]?.detected_language ?? undefined,
      transcript: alt.transcript ?? "", words: alt.words ?? [], utterances, sentences,
      model: Array.isArray(models) ? models.join(", ") : models, duration: data?.metadata?.duration,
      requestId: data?.metadata?.request_id };
    await setState(done);  // transcript shows now; translation fills in below
    if (translateTo) {
      if (sentences.length) await translateAll(done, base, language, translateTo, gen);
      else await setState({ ...done, tr: { target: translateTo, status: "error", done: 0, total: 0, items: [], startedAt: Date.now(),
        finishedAt: Date.now(), error: "no sentences in the transcript to translate" } });
    }
    // Post-processing, strictly on demand: only when "Remove vocals" was on at drop, and only now that
    // the transcript and translation have been delivered.
    // Re-check the setting: it may have been unticked while transcribing/translating (0.6.2).
    if (separateVocals && gen === generation && (await chrome.storage.local.get({ separate: false })).separate === true) await separate(language, base);
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
  // Spoken language for the translator: the picked one, else the server's guess for the whole transcript
  // (per-sentence guesses are unreliable on short lines, and 'auto' makes the model echo more often).
  const source = language === "auto" ? job.detectedLanguage ?? "auto" : language;
  const tr: TranslationState = { target, status: "warming", done: 0, total: sentences.length,
    items: sentences.map(() => null), startedAt: Date.now() };
  const publish = async () => {
    if (gen !== generation) return;
    const sep = (await getState()).sep;  // keep a vocal-removal job that may be running alongside a retranslation
    await setState({ ...job, ...(sep ? { sep } : {}), tr: { ...tr, items: [...tr.items] } });
  };
  const post = async (batch: Sentence[]): Promise<any> => {
    for (let attempt = 1; ; attempt++) {
      if (gen !== generation) return null;
      let r: Response;
      try {
        r = await fetch(`${base}/v1/translate`, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target, source, sentences: batch }) });
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

// ---- vocal removal (only ever called for an explicit "Remove vocals")
async function separate(language: string, baseArg?: string) {
  const job0 = await getState();
  if (job0.phase !== "done" || (job0.sep && job0.sep.status !== "error")) return;
  const audio = await getAudio();
  if (!audio) return;
  const g = ++sepGen;
  const base = (baseArg ?? ((await chrome.storage.local.get({ server: "" })).server as string)).replace(/\/+$/, "");
  let sep: SeparationState = { base, status: "starting", progress: 0, startedAt: Date.now() };
  const publish = async () => {
    if (g !== sepGen) return false;
    const cur = await getState();
    if (cur.phase !== "done") return false;
    await setState({ ...cur, sep });
    return true;
  };
  const fail = async (error: string) => { sep = { ...sep, status: "error", error, finishedAt: Date.now() }; await publish(); };
  const ka = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000);
  try {
    if (!(await publish())) return;
    const lang = LANGS.includes(language) ? language : "auto";
    let r: Response;
    try {
      r = await fetch(`${base}/v1/separate?language=${encodeURIComponent(lang)}`, { method: "POST",
        headers: { "Content-Type": audio.blob.type || "application/octet-stream", "X-Filename": encodeURIComponent(audio.name) },
        body: audio.blob });
    } catch (e) { await fail(`could not reach the server (${(e as Error).message})`); return; }
    const { text, data } = await readJson(r);
    if (r.status === 404) { await fail("server predates /v1/separate (redeploy the service to 0.7.0)"); return; }
    if (!r.ok) { await fail(`Error ${r.status}: ${data?.err_msg ?? text.slice(0, 200)}`); return; }
    sep = applyJob({ ...sep, jobId: data.job_id, status: "queued" }, data);
    if (!(await publish())) return;
    for (let misses = 0; ;) {
      await sleep(2000);
      if (g !== sepGen) return;
      let p: Response;
      try { p = await fetch(`${base}/v1/jobs/${sep.jobId}`); }
      catch { if (++misses > 15) { await fail("lost contact with the server"); return; } continue; }
      if (p.status === 404) { await fail("job expired or was deleted on the server"); return; }
      const j = (await readJson(p)).data;
      if (!p.ok || !j) { if (++misses > 15) { await fail(`Error ${p.status}`); return; } continue; }
      misses = 0;
      sep = applyJob(sep, j);
      if (sep.status === "done" || sep.status === "error") sep.finishedAt = Date.now();
      if (!(await publish())) return;
      if (sep.status === "done" || sep.status === "error") return;
    }
  } catch (e) { await fail(`Extension error: ${(e as Error).message}`); }
  finally { clearInterval(ka); }
}
